import { and, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  SendInvitationsBody,
  SendInvitationsResponse,
} from "@workspace/api-zod";
import {
  appUsersTable,
  campaignsTable,
  campaignRecipientsTable,
  db,
  eventSettingsTable,
  icloudSettingsTable,
  recipientsTable,
} from "@workspace/db";
import { CalDAVError, testICloudConnection } from "../lib/icloud-caldav";
import { publishCampaignEvent, subscribeToCampaignEvents } from "../lib/campaign-events";
import { recordActivity } from "../lib/activity";
import { getOwnerId } from "../middlewares/workspace";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const SENDING_STATUSES = ["running"];
const REPLACEABLE_LEGACY_STATUSES = ["queued", "paused"];
const CAMPAIGN_RECIPIENT_BATCH_SIZE = 1_000;
const DEFAULT_EVENT = {
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
  startAt: null as Date | null,
};
type EventTimeSettings = {
  minimumLeadMinutes: number;
  automaticTimeSelection: boolean;
  startAt: Date | null;
};

function invitationSendForApi(campaign: typeof campaignsTable.$inferSelect) {
  return SendInvitationsResponse.parse({
    id: campaign.id,
    status: campaign.status,
    total: campaign.total,
    eventsSaved: campaign.eventsCreated,
    sent: campaign.invitationsProcessed,
    failed: campaign.failed,
    pending: campaign.pending,
    createdAt: campaign.createdAt.toISOString(),
  });
}

function startAtForCampaign(settings: EventTimeSettings): Date | null {
  const now = Date.now();
  const earliest = now + settings.minimumLeadMinutes * 60_000;
  if (settings.automaticTimeSelection) {
    return new Date(Math.ceil(earliest / 60_000) * 60_000);
  }
  if (!settings.startAt) return null;
  if (settings.startAt.getTime() < earliest) return null;
  return settings.startAt;
}

router.get("/invitation-sends/events", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const unsubscribe = subscribeToCampaignEvents(getOwnerId(req), res);
  req.on("close", unsubscribe);
});

router.post("/invitation-sends", async (req, res, next) => {
  const parsed = SendInvitationsBody.safeParse(req.body);
  if (!parsed.success || parsed.data.confirmed !== true) {
    res.status(400).json({ error: "Confirm the current recipient list before sending." });
    return;
  }
  const ownerId = getOwnerId(req);
  try {
    const [active] = await db
      .select({ id: campaignsTable.id })
      .from(campaignsTable)
      .where(
        and(
          eq(campaignsTable.ownerId, ownerId),
          inArray(campaignsTable.status, SENDING_STATUSES),
        ),
      )
      .limit(1);
    if (active) {
      res.status(409).json({ error: "A one-time send is already in progress." });
      return;
    }

    const [inFlightWork] = await db
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
    if (inFlightWork) {
      res.status(409).json({
        error: "A previous event is still finishing. Wait for it to finish before sending again.",
      });
      return;
    }

    const [account] = await db
      .select()
      .from(icloudSettingsTable)
      .where(eq(icloudSettingsTable.ownerId, ownerId))
      .limit(1);
    if (!account?.appPassword || account.status !== "connected") {
      res.status(409).json({
        error: "Connect and test an iCloud account before sending invitations.",
      });
      return;
    }
    const [savedEventSettings] = await db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.ownerId, ownerId))
      .limit(1);
    const eventSettings = savedEventSettings ?? DEFAULT_EVENT;
    const eventStartAt = startAtForCampaign({
      ...eventSettings,
      startAt: eventSettings.startAt,
    });
    if (!eventStartAt) {
      res.status(400).json({
        error: "Choose a start time at least the configured minimum lead time from now.",
      });
      return;
    }

    const [hasRecipients] = await db
      .select({ id: recipientsTable.id })
      .from(recipientsTable)
      .where(
        and(
          eq(recipientsTable.ownerId, ownerId),
          eq(recipientsTable.isValid, true),
        ),
      )
      .limit(1);
    if (!hasRecipients) {
      res.status(400).json({ error: "Add at least one valid recipient first." });
      return;
    }

    const password = account.appPassword;
    let connection;
    try {
      connection = await testICloudConnection(account.email, password);
    } catch (error) {
      const message =
        error instanceof CalDAVError
          ? error.message
          : "The iCloud connection could not be verified.";
      logger.warn(
        {
          code: error instanceof CalDAVError ? error.code : "unknown",
        },
        "One-time send preflight connection test failed",
      );
      if (error instanceof CalDAVError && error.code === "AUTHENTICATION_FAILED") {
        await db
          .update(icloudSettingsTable)
          .set({ status: "authentication-failed", updatedAt: new Date() })
          .where(eq(icloudSettingsTable.ownerId, ownerId));
      }
      res.status(error instanceof CalDAVError ? 502 : 503).json({ error: message });
      return;
    }
    if (connection.status !== "connected") {
      if (
        connection.status === "authentication-failed" ||
        connection.status === "calendar-unavailable"
      ) {
        await db
          .update(icloudSettingsTable)
          .set({
            status: connection.status,
            invitationMode: connection.invitationMode,
            calendars: connection.calendars,
            updatedAt: new Date(),
          })
          .where(eq(icloudSettingsTable.ownerId, ownerId));
      }
      res.status(connection.status === "server-unavailable" ? 502 : 409).json({
        error: connection.message,
      });
      return;
    }
    const selectedCalendar = connection.calendars.find(
      (calendar) => calendar.href === account.calendarHref,
    );
    if (!selectedCalendar) {
      await db
        .update(icloudSettingsTable)
        .set({
          status: "calendar-unavailable",
          calendars: connection.calendars,
          invitationMode: connection.invitationMode,
          updatedAt: new Date(),
        })
        .where(eq(icloudSettingsTable.ownerId, ownerId));
      res.status(409).json({
        error: "The selected calendar is no longer available. Choose a discovered calendar again.",
      });
      return;
    }
    try {
      const created = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${ownerId}))`,
        );
        const [owner] = await tx
          .select({ id: appUsersTable.id })
          .from(appUsersTable)
          .where(eq(appUsersTable.id, ownerId))
          .limit(1);
        if (!owner) return { reason: "account-removed" as const };

        const [activeCampaign] = await tx
          .select({ id: campaignsTable.id })
          .from(campaignsTable)
          .where(
            and(
              eq(campaignsTable.ownerId, ownerId),
              inArray(campaignsTable.status, SENDING_STATUSES),
            ),
          )
          .limit(1);
        if (activeCampaign) return { reason: "active" as const };

        const [inFlightWork] = await tx
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
        if (inFlightWork) return { reason: "send-processing" as const };

        const [latestAccount] = await tx
          .select()
          .from(icloudSettingsTable)
          .where(eq(icloudSettingsTable.ownerId, ownerId))
          .for("update")
          .limit(1);
        if (
          !latestAccount ||
          latestAccount.email !== account.email ||
          latestAccount.appPassword !== password ||
          latestAccount.calendarHref !== account.calendarHref
        ) {
          return { reason: "icloud-settings-changed" as const };
        }

        const [latestEventSettings] = await tx
          .select()
          .from(eventSettingsTable)
          .where(eq(eventSettingsTable.ownerId, ownerId))
          .for("share")
          .limit(1);
        const currentEventSettings = latestEventSettings ?? DEFAULT_EVENT;
        const currentEventStartAt = startAtForCampaign({
          ...currentEventSettings,
          startAt: currentEventSettings.startAt,
        });
        if (!currentEventStartAt) {
          return { reason: "invalid-start-time" as const };
        }

        const currentRecipients = await tx
          .select()
          .from(recipientsTable)
          .where(
            and(
              eq(recipientsTable.ownerId, ownerId),
              eq(recipientsTable.isValid, true),
            ),
          )
          .orderBy(recipientsTable.createdAt)
          .for("share");
        if (currentRecipients.length === 0) {
          return { reason: "no-recipients" as const };
        }

        await tx
          .update(icloudSettingsTable)
          .set({
            status: "connected",
            invitationMode: connection.invitationMode,
            calendars: connection.calendars,
            updatedAt: new Date(),
          })
          .where(eq(icloudSettingsTable.ownerId, ownerId));

        await tx
          .update(campaignsTable)
          .set({ status: "stopped", completedAt: new Date() })
          .where(
            and(
              eq(campaignsTable.ownerId, ownerId),
              inArray(campaignsTable.status, REPLACEABLE_LEGACY_STATUSES),
            ),
          );

        const [campaign] = await tx
          .insert(campaignsTable)
          .values({
            ownerId,
            title: currentEventSettings.title || "Calendar event",
            status: "running",
            total: currentRecipients.length,
            pending: currentRecipients.length,
            eventStartAt: currentEventStartAt,
            eventSnapshot: {
              runType: "one-time-send",
              title: currentEventSettings.title,
              location: currentEventSettings.location,
              url: currentEventSettings.url,
              note: currentEventSettings.note,
              inviteAsAttendees: currentEventSettings.inviteAsAttendees,
              inviteesPerEvent: currentEventSettings.inviteesPerEvent,
              timezone: currentEventSettings.timezone,
              durationMinutes: currentEventSettings.durationMinutes,
            },
          })
          .returning();
        if (!campaign) throw new Error("One-time send insert returned no row");

        for (let offset = 0; offset < currentRecipients.length; offset += CAMPAIGN_RECIPIENT_BATCH_SIZE) {
          const batch = currentRecipients.slice(offset, offset + CAMPAIGN_RECIPIENT_BATCH_SIZE);
          await tx.insert(campaignRecipientsTable).values(
            batch.map((recipient) => ({
              campaignId: campaign.id,
              recipientId: recipient.id,
              status: "pending",
            })),
          );
        }
        for (let offset = 0; offset < currentRecipients.length; offset += CAMPAIGN_RECIPIENT_BATCH_SIZE) {
          const batch = currentRecipients.slice(offset, offset + CAMPAIGN_RECIPIENT_BATCH_SIZE);
          await tx
            .update(recipientsTable)
            .set({ status: "pending" })
            .where(
              and(
                eq(recipientsTable.ownerId, ownerId),
                inArray(
                  recipientsTable.id,
                  batch.map((recipient) => recipient.id),
                ),
              ),
            );
        }
        return { reason: "created" as const, campaign };
      });

      if (created.reason === "account-removed") {
        res.status(401).json({ error: "This account is no longer available." });
        return;
      }
      if (created.reason === "active") {
        res.status(409).json({ error: "A one-time send is already in progress." });
        return;
      }
      if (created.reason === "send-processing") {
        res.status(409).json({
          error: "A previous event is still finishing. Wait for it to finish before sending again.",
        });
        return;
      }
      if (created.reason === "icloud-settings-changed") {
        res.status(409).json({
          error: "The iCloud account settings changed during the connection check. Test the connection again before sending.",
        });
        return;
      }
      if (created.reason === "invalid-start-time") {
        res.status(400).json({
          error: "Choose a start time at least the configured minimum lead time from now.",
        });
        return;
      }
      if (created.reason === "no-recipients") {
        res.status(400).json({ error: "Add at least one valid recipient first." });
        return;
      }
      const campaign = created.campaign;
      await recordActivity(
        ownerId,
        "info",
        "invitation-send-started",
        `One-time invitation send started for ${campaign.total} current valid recipients.`,
      );
      publishCampaignEvent(ownerId, {
        type: "campaign-progress",
        campaignId: campaign.id,
      });
      res.status(202).json(invitationSendForApi(campaign));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        res.status(409).json({ error: "A one-time send is already in progress." });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

router.post("/invitation-sends/:id/stop", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invitation send ID is invalid." });
    return;
  }

  const ownerId = getOwnerId(req);
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ownerId}))`);
      const [send] = await tx
        .select({ id: campaignsTable.id, status: campaignsTable.status })
        .from(campaignsTable)
        .where(
          and(
            eq(campaignsTable.id, id),
            eq(campaignsTable.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!send) return { reason: "missing" as const };
      if (send.status !== "running") {
        return { reason: "not-running" as const };
      }

      const [inFlight] = await tx
        .select({ id: campaignRecipientsTable.id })
        .from(campaignRecipientsTable)
        .where(
          and(
            eq(campaignRecipientsTable.campaignId, id),
            eq(campaignRecipientsTable.status, "invitation-processing"),
          ),
        )
        .limit(1);

      await tx
        .update(campaignsTable)
        .set({ status: "stopped", completedAt: new Date() })
        .where(
          and(
            eq(campaignsTable.id, id),
            eq(campaignsTable.ownerId, ownerId),
            eq(campaignsTable.status, "running"),
          ),
        );
      return { reason: "stopped" as const, id, inFlight: Boolean(inFlight) };
    });

    if (result.reason === "missing") {
      res.status(404).json({ error: "Invitation send not found." });
      return;
    }
    if (result.reason === "not-running") {
      res.status(409).json({ error: "This invitation send is no longer running." });
      return;
    }

    await recordActivity(
      ownerId,
      "warning",
      "invitation-send-stopped",
      result.inFlight
        ? "One-time invitation send stopped. The event already being saved may still finish; pending recipient groups will not be started."
        : "One-time invitation send stopped. Pending recipient groups will not be started.",
    );
    publishCampaignEvent(ownerId, {
      type: "campaign-progress",
      campaignId: result.id,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;