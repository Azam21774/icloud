import { and, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  eventSettingsTable,
  icloudSettingsTable,
  campaignRecipientsTable,
  campaignsTable,
} from "@workspace/db";
import {
  DeleteIcloudCredentialsResponse,
  GetEventSettingsResponse,
  GetIcloudSettingsResponse,
  SaveIcloudSettingsBody,
  SaveIcloudSettingsResponse,
  TestIcloudConnectionBody,
  TestIcloudConnectionResponse,
  UpdateEventSettingsBody,
  UpdateEventSettingsResponse,
} from "@workspace/api-zod";
import { getOwnerId } from "../middlewares/workspace";
import {
  CalDAVError,
  testICloudConnection,
  type CalDAVTestResult,
} from "../lib/icloud-caldav";
import { recordActivity } from "../lib/activity";

const router: IRouter = Router();

const defaultEventSettings = {
  title: "Team Meeting",
  location: "",
  url: "",
  note: "",
  inviteAsAttendees: true,
  inviteesPerEvent: 1,
  timezone: "America/New_York",
  durationMinutes: 30,
  minimumLeadMinutes: 15,
  automaticTimeSelection: true,
  startAt: null,
};

function formatEventSettings(
  row:
    | typeof eventSettingsTable.$inferSelect
    | undefined,
) {
  return GetEventSettingsResponse.parse({
    ...(row ?? defaultEventSettings),
    startAt: row?.startAt?.toISOString() ?? null,
  });
}

function formatICloudSettings(
  row: typeof icloudSettingsTable.$inferSelect | undefined,
) {
  return GetIcloudSettingsResponse.parse({
    email: row?.email ?? "",
    calendarName: row?.calendarName ?? "",
    timezone: row?.timezone ?? "America/New_York",
    status: row?.status ?? "not-connected",
    hasStoredPassword: Boolean(row?.appPassword),
    calendars: row?.calendars ?? [],
    invitationMode: row?.invitationMode ?? "calendar-only",
  });
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function connectionErrorResult(error: unknown): CalDAVTestResult {
  if (error instanceof CalDAVError) {
    const status =
      error.code === "AUTHENTICATION_FAILED"
        ? "authentication-failed"
        : error.code === "CALENDAR_UNAVAILABLE"
          ? "calendar-unavailable"
          : "server-unavailable";
    return {
      status,
      calendars: [],
      invitationMode: "calendar-only",
      message: error.message,
    };
  }
  return {
    status: "server-unavailable",
    calendars: [],
    invitationMode: "calendar-only",
    message: "The connection test could not be completed. Try again.",
  };
}

async function hasActiveSend(ownerId: string): Promise<boolean> {
  const [running] = await db
    .select({ id: campaignsTable.id })
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.ownerId, ownerId),
        eq(campaignsTable.status, "running"),
      ),
    )
    .limit(1);
  if (running) return true;

  const [processing] = await db
    .select({ id: campaignRecipientsTable.id })
    .from(campaignRecipientsTable)
    .innerJoin(
      campaignsTable,
      eq(campaignRecipientsTable.campaignId, campaignsTable.id),
    )
    .where(
      and(
        eq(campaignsTable.ownerId, ownerId),
        eq(campaignRecipientsTable.status, "invitation-processing"),
      ),
    )
    .limit(1);
  return Boolean(processing);
}

router.get("/event-settings", async (req, res, next) => {
  try {
    const [row] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.ownerId, getOwnerId(req)))
      .limit(1);
    res.json(formatEventSettings(row));
  } catch (error) {
    next(error);
  }
});

router.put("/event-settings", async (req, res, next) => {
  try {
    const parsed = UpdateEventSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Event settings are invalid." });
      return;
    }
    const input = parsed.data;
    if (!validTimeZone(input.timezone)) {
      res.status(400).json({ error: "Choose a valid time zone." });
      return;
    }
    if (input.url) {
      try {
        const url = new URL(input.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("Unsupported URL protocol");
        }
      } catch {
        res.status(400).json({ error: "The event URL must be a valid http or https URL." });
        return;
      }
    }
    if (input.startAt && Number.isNaN(input.startAt.getTime())) {
      res.status(400).json({ error: "Choose a valid event start time." });
      return;
    }

    const ownerId = getOwnerId(req);
    const [row] = await db
      .insert(eventSettingsTable)
      .values({
        ownerId,
        title: input.title,
        location: input.location,
        url: input.url,
        note: input.note,
        inviteAsAttendees: input.inviteAsAttendees,
        inviteesPerEvent: input.inviteesPerEvent,
        timezone: input.timezone,
        durationMinutes: input.durationMinutes,
        minimumLeadMinutes: input.minimumLeadMinutes,
        automaticTimeSelection: input.automaticTimeSelection,
        startAt: input.startAt ? new Date(input.startAt) : null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: eventSettingsTable.ownerId,
        set: {
          title: input.title,
          location: input.location,
          url: input.url,
          note: input.note,
          inviteAsAttendees: input.inviteAsAttendees,
          inviteesPerEvent: input.inviteesPerEvent,
          timezone: input.timezone,
          durationMinutes: input.durationMinutes,
          minimumLeadMinutes: input.minimumLeadMinutes,
          automaticTimeSelection: input.automaticTimeSelection,
          startAt: input.startAt ? new Date(input.startAt) : null,
          updatedAt: new Date(),
        },
      })
      .returning();
    res.json(formatEventSettings(row));
  } catch (error) {
    next(error);
  }
});

router.get("/icloud-settings", async (req, res, next) => {
  try {
    const [row] = await db
      .select()
      .from(icloudSettingsTable)
      .where(eq(icloudSettingsTable.ownerId, getOwnerId(req)))
      .limit(1);
    res.json(formatICloudSettings(row));
  } catch (error) {
    next(error);
  }
});

router.post("/icloud-settings/test", async (req, res, next) => {
  const parsed = TestIcloudConnectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid iCloud email and app-specific password." });
    return;
  }
  try {
    const result = await testICloudConnection(
      parsed.data.email.trim(),
      parsed.data.appPassword,
    );
    res.json(TestIcloudConnectionResponse.parse(result));
  } catch (error) {
    if (error instanceof CalDAVError) {
      req.log?.warn({ code: error.code }, "iCloud connection test failed");
    } else {
      req.log?.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "iCloud connection test failed",
      );
    }
    res.json(TestIcloudConnectionResponse.parse(connectionErrorResult(error)));
  }
});

router.put("/icloud-settings", async (req, res, next) => {
  let failureStage = "validate-input";
  try {
    const parsed = SaveIcloudSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "iCloud settings are invalid." });
      return;
    }
    const input = parsed.data;
    if (!validTimeZone(input.timezone)) {
      res.status(400).json({ error: "Choose a valid time zone." });
      return;
    }
    const ownerId = getOwnerId(req);
    failureStage = "check-active-send";
    if (await hasActiveSend(ownerId)) {
      res.status(409).json({
        error: "Wait for the active invitation send to finish before changing the iCloud connection.",
      });
      return;
    }

    failureStage = "load-existing-settings";
    const [existing] = await db
      .select()
      .from(icloudSettingsTable)
      .where(eq(icloudSettingsTable.ownerId, ownerId))
      .limit(1);
    const email = input.email.trim();
    let appPassword = input.appPassword;
    if (!appPassword && existing?.appPassword) {
      if (existing.email.toLowerCase() !== email.toLowerCase()) {
        res.status(400).json({
          error: "Enter an app-specific password when changing the iCloud email.",
        });
        return;
      }
      failureStage = "reuse-saved-password";
      appPassword = existing.appPassword;
    }
    if (!appPassword) {
      res.status(400).json({
        error: "Enter an app-specific password and test the connection first.",
      });
      return;
    }

    failureStage = "verify-icloud-connection";
    const test = await testICloudConnection(email, appPassword);
    if (test.status !== "connected") {
      const statusCode =
        test.status === "authentication-failed"
          ? 401
          : test.status === "server-unavailable"
            ? 502
            : 400;
      res.status(statusCode).json({ error: test.message });
      return;
    }

    failureStage = "select-discovered-calendar";
    const namedCalendars = test.calendars.filter(
      (calendar) => calendar.name === input.calendarName,
    );
    const calendar = input.calendarHref
      ? test.calendars.find((item) => item.href === input.calendarHref)
      : namedCalendars.length === 1
        ? namedCalendars[0]
        : undefined;
    if (!calendar) {
      res.status(400).json({
        error:
          namedCalendars.length > 1
            ? "Choose a calendar by its discovered calendar address."
            : "Choose a calendar discovered from this iCloud account.",
      });
      return;
    }

    failureStage = "save-settings";
    const [saved] = await db
      .insert(icloudSettingsTable)
      .values({
        ownerId,
        email,
        appPassword,
        calendarName: calendar.name,
        calendarHref: calendar.href,
        timezone: input.timezone,
        status: "connected",
        invitationMode: test.invitationMode,
        calendars: test.calendars,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: icloudSettingsTable.ownerId,
        set: {
          email,
          appPassword,
          calendarName: calendar.name,
          calendarHref: calendar.href,
          timezone: input.timezone,
          status: "connected",
          invitationMode: test.invitationMode,
          calendars: test.calendars,
          updatedAt: new Date(),
        },
      })
      .returning();

    failureStage = "record-activity";
    await recordActivity(
      ownerId,
      "info",
      "icloud-connected",
      "The iCloud account was verified and its calendar settings were saved.",
    );
    failureStage = "validate-save-response";
    res.json(SaveIcloudSettingsResponse.parse(formatICloudSettings(saved)));
  } catch (error) {
    if (error instanceof CalDAVError) {
      const status =
        error.code === "AUTHENTICATION_FAILED"
          ? 401
          : error.code === "SERVER_UNAVAILABLE"
            ? 502
            : 400;
      res.status(status).json({ error: error.message });
      return;
    }
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    req.log?.error(
      {
        failureStage,
        errorName: error instanceof Error ? error.name : "unknown",
        errorCode,
      },
      "iCloud account settings save failed",
    );
    next(error);
  }
});

router.delete("/icloud-settings", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    if (await hasActiveSend(ownerId)) {
      res.status(409).json({
        error: "Wait for the active invitation send to finish before removing the iCloud connection.",
      });
      return;
    }
    const [existing] = await db
      .select()
      .from(icloudSettingsTable)
      .where(eq(icloudSettingsTable.ownerId, ownerId))
      .limit(1);
    const [saved] = await db
      .insert(icloudSettingsTable)
      .values({
        ownerId,
        email: "",
        appPassword: null,
        calendarName: "",
        calendarHref: "",
        timezone: existing?.timezone ?? "America/New_York",
        status: "not-connected",
        invitationMode: "calendar-only",
        calendars: [],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: icloudSettingsTable.ownerId,
        set: {
          email: "",
          appPassword: null,
          calendarName: "",
          calendarHref: "",
          status: "not-connected",
          invitationMode: "calendar-only",
          calendars: [],
          updatedAt: new Date(),
        },
      })
      .returning();
    await recordActivity(
      ownerId,
      "info",
      "icloud-disconnected",
      "The saved iCloud credentials and calendar selection were removed.",
    );
    res.json(DeleteIcloudCredentialsResponse.parse(formatICloudSettings(saved)));
  } catch (error) {
    next(error);
  }
});

export default router;