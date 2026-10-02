import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateAdminUserBody,
  CreateAdminUserResponse,
  DeleteAdminUserParams,
  ListAdminUsersResponse,
  ResetUserPasswordResponse,
  ResetUserPasswordParams,
} from "@workspace/api-zod";
import {
  activityLogsTable,
  appSessionsTable,
  appUsersTable,
  campaignRecipientsTable,
  campaignsTable,
  db,
  eventSettingsTable,
  icloudSettingsTable,
  recipientsTable,
} from "@workspace/db";
import { disconnectCampaignSubscribers } from "../lib/campaign-events";
import { createAccountId, generateTemporaryPassword, hashPassword, isValidUsername, normalizeUsername } from "../lib/auth";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

router.use("/admin/users", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use("/admin/users", requireAdmin);

router.get("/admin/users", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        id: appUsersTable.id,
        username: appUsersTable.username,
        createdAt: appUsersTable.createdAt,
        lastLoginAt: appUsersTable.lastLoginAt,
      })
      .from(appUsersTable)
      .where(eq(appUsersTable.role, "user"))
      .orderBy(desc(appUsersTable.createdAt));
    res.json(
      ListAdminUsersResponse.parse(
        rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        })),
      ),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/admin/users", async (req, res, next) => {
  try {
    const parsed = CreateAdminUserBody.safeParse(req.body);
    if (!parsed.success || !isValidUsername(parsed.data.username)) {
      res.status(400).json({ error: "Enter a valid username." });
      return;
    }

    const username = parsed.data.username.trim();
    const generatedPassword = generateTemporaryPassword();
    const [created] = await db
      .insert(appUsersTable)
      .values({
        id: createAccountId(),
        username,
        normalizedUsername: normalizeUsername(username),
        passwordHash: await hashPassword(generatedPassword),
        role: "user",
      })
      .returning({
        id: appUsersTable.id,
        username: appUsersTable.username,
        createdAt: appUsersTable.createdAt,
        lastLoginAt: appUsersTable.lastLoginAt,
      });
    res.status(201).json(
      CreateAdminUserResponse.parse({
        ...created,
        createdAt: created.createdAt.toISOString(),
        lastLoginAt: null,
        generatedPassword,
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "That username is already in use." });
      return;
    }
    next(error);
  }
});

router.post("/admin/users/:id/password", async (req, res, next) => {
  try {
    const params = ResetUserPasswordParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid user account." });
      return;
    }

    const generatedPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(generatedPassword);
    const result = await db.transaction(async (tx) => {
      const updated = await tx
        .update(appUsersTable)
        .set({ passwordHash })
        .where(
          and(
            eq(appUsersTable.id, params.data.id),
            eq(appUsersTable.role, "user"),
          ),
        )
        .returning({ id: appUsersTable.id });
      if (updated.length === 0) return null;

      const removedSessions = await tx
        .delete(appSessionsTable)
        .where(eq(appSessionsTable.userId, params.data.id))
        .returning({ id: appSessionsTable.id });
      return removedSessions.length;
    });

    if (result === null) {
      res.status(404).json({ error: "User account not found." });
      return;
    }
    res.json(
      ResetUserPasswordResponse.parse({
        success: true,
        sessionsRevoked: result,
        generatedPassword,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.delete("/admin/users/:id", async (req, res, next) => {
  try {
    const params = DeleteAdminUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid user account." });
      return;
    }
    const userId = params.data.id;

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`,
      );
      const [target] = await tx
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .where(
          and(
            eq(appUsersTable.id, userId),
            eq(appUsersTable.role, "user"),
          ),
        )
        .for("update")
        .limit(1);
      if (!target) return "missing" as const;

      const [activeSend] = await tx
        .select({ id: campaignsTable.id })
        .from(campaignsTable)
        .where(
          and(
            eq(campaignsTable.ownerId, userId),
            eq(campaignsTable.status, "running"),
          ),
        )
        .limit(1);
      if (activeSend) return "active" as const;

      const [processing] = await tx
        .select({ id: campaignRecipientsTable.id })
        .from(campaignRecipientsTable)
        .innerJoin(
          campaignsTable,
          eq(campaignRecipientsTable.campaignId, campaignsTable.id),
        )
        .where(
          and(
            eq(campaignsTable.ownerId, userId),
            eq(campaignRecipientsTable.status, "invitation-processing"),
          ),
        )
        .limit(1);
      if (processing) return "active" as const;

      await tx
        .delete(campaignsTable)
        .where(eq(campaignsTable.ownerId, userId));
      await tx
        .delete(recipientsTable)
        .where(eq(recipientsTable.ownerId, userId));
      await tx
        .delete(eventSettingsTable)
        .where(eq(eventSettingsTable.ownerId, userId));
      await tx
        .delete(icloudSettingsTable)
        .where(eq(icloudSettingsTable.ownerId, userId));
      await tx
        .delete(activityLogsTable)
        .where(eq(activityLogsTable.ownerId, userId));
      await tx
        .delete(appSessionsTable)
        .where(eq(appSessionsTable.userId, userId));
      await tx
        .delete(appUsersTable)
        .where(
          and(
            eq(appUsersTable.id, userId),
            eq(appUsersTable.role, "user"),
          ),
        );
      return "deleted" as const;
    });

    if (result === "missing") {
      res.status(404).json({ error: "User account not found." });
      return;
    }
    if (result === "active") {
      res.status(409).json({
        error: "Wait for the user's invitation send to finish before deleting the account.",
      });
      return;
    }

    disconnectCampaignSubscribers(userId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;