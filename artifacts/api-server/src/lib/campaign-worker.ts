import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  campaignsTable,
  campaignRecipientsTable,
  db,
  icloudSettingsTable,
  pool,
  recipientsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { createICloudEvent, type CalDAVMode, CalDAVError } from "./icloud-caldav";
import { recordActivity } from "./activity";
import { publishCampaignEvent } from "./campaign-events";

type ClaimedCampaignRecipient = {
  id: number;
  campaign_id: number;
  recipient_id: number;
};

function formatRecipients(
  members: Array<{ recipient: { email: string; name: string | null } }>,
): string {
  return members
    .map(({ recipient }) =>
      recipient.name
        ? `${recipient.name} <${recipient.email}>`
        : recipient.email,
    )
    .join("; ");
}

let isRunning = false;
let timer: NodeJS.Timeout | undefined;

async function processNextEventGroup(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const claim = await pool.query<ClaimedCampaignRecipient>(
      `WITH next_campaign AS (
        SELECT
          campaign.id,
          LEAST(
            5000,
            GREATEST(
              1,
              COALESCE(
                NULLIF(campaign.event_snapshot->>'inviteesPerEvent', '')::integer,
                1
              )
            )
          ) AS batch_size
        FROM campaigns AS campaign
        WHERE campaign.status = 'running'
          AND EXISTS (
            SELECT 1
            FROM campaign_recipients AS pending_task
            WHERE pending_task.campaign_id = campaign.id
              AND pending_task.status = 'pending'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM campaign_recipients AS active_task
            WHERE active_task.campaign_id = campaign.id
              AND active_task.status = 'invitation-processing'
          )
        ORDER BY campaign.created_at ASC, campaign.id ASC
        FOR UPDATE OF campaign SKIP LOCKED
        LIMIT 1
      ),
      next_jobs AS (
        SELECT task.id
        FROM campaign_recipients AS task
        INNER JOIN next_campaign AS campaign
          ON campaign.id = task.campaign_id
        WHERE task.status = 'pending'
        ORDER BY task.id ASC
        FOR UPDATE OF task SKIP LOCKED
        LIMIT (SELECT batch_size FROM next_campaign)
      )
      UPDATE campaign_recipients AS task
      SET status = 'invitation-processing', claimed_at = NOW()
      FROM next_jobs
      WHERE task.id = next_jobs.id
      RETURNING task.id, task.campaign_id, task.recipient_id`,
    );
    const works = claim.rows;
    const work = works[0];
    if (!work) return;

    const [campaign] = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.id, work.campaign_id))
      .limit(1);
    if (!campaign) return;

    if (campaign.status !== "running") {
      await db
        .update(campaignRecipientsTable)
        .set({
          status: "pending",
          claimedAt: null,
        })
        .where(
          and(
            eq(campaignRecipientsTable.campaignId, campaign.id),
            inArray(campaignRecipientsTable.id, works.map((item) => item.id)),
          ),
        );
      return;
    }

    const recipients = await db
      .select()
      .from(recipientsTable)
      .where(
        and(
          inArray(recipientsTable.id, works.map((item) => item.recipient_id)),
          eq(recipientsTable.ownerId, campaign.ownerId),
        ),
      );
    const recipientsById = new Map(recipients.map((recipient) => [recipient.id, recipient]));
    const members = works.flatMap((item) => {
      const recipient = recipientsById.get(item.recipient_id);
      return recipient ? [{ work: item, recipient }] : [];
    });
    const missingRecipientWorks = works.filter(
      (item) => !recipientsById.has(item.recipient_id),
    );
    if (missingRecipientWorks.length > 0) {
      await markRecipientGroupFailed(
        campaign.id,
        campaign.ownerId,
        missingRecipientWorks,
        "A recipient could not be loaded for this event.",
      );
    }
    if (members.length === 0) return;

    const [account] = await db
      .select()
      .from(icloudSettingsTable)
      .where(eq(icloudSettingsTable.ownerId, campaign.ownerId))
      .limit(1);
    if (
      !account?.appPassword ||
      account.status !== "connected" ||
      !account.calendarHref ||
      !campaign.eventStartAt
    ) {
      await markRecipientGroupFailed(
        campaign.id,
        campaign.ownerId,
        members.map((member) => member.work),
        `Send settings changed before event "${campaign.title}" could be processed. Recipients: ${formatRecipients(members)}.`,
      );
      return;
    }

    const snapshot = campaign.eventSnapshot;
    const attendees = snapshot.inviteAsAttendees
      ? members.map(({ recipient }) => ({
          email: recipient.email,
          name: recipient.name,
        }))
      : [];
    let calendarWriteSucceeded = false;
    try {
      const credentials = account.appPassword;
      const groupingSize = snapshot.inviteesPerEvent ?? 1;
      const restartGeneration = snapshot.restartGeneration ?? 0;
      const uidMaterial = groupingSize === 1 && restartGeneration === 0
        ? `${campaign.ownerId}\u0000${account.calendarHref}\u0000${members[0].recipient.id}\u0000${campaign.eventStartAt.toISOString()}`
        : `${campaign.ownerId}\u0000${account.calendarHref}\u0000${campaign.id}\u0000${members[0].work.id}\u0000${campaign.eventStartAt.toISOString()}`;
      const eventUid = `${createHash("sha256")
        .update(uidMaterial)
        .digest("hex")
        .slice(0, 32)}@invite-ledger`;
      const recipientSummary = formatRecipients(members);
      const schedulingAdvertised =
        account.invitationMode === "caldav-scheduling";
      await recordActivity(
        campaign.ownerId,
        "info",
        "invitation-send-event-submitting",
        attendees.length > 0
          ? schedulingAdvertised
            ? `Submitting event "${snapshot.title}" with an invitation request for ${attendees.length} invitee${attendees.length === 1 ? "" : "s"}: ${recipientSummary}.`
            : `Saving event "${snapshot.title}" with ${attendees.length} attendee${attendees.length === 1 ? "" : "s"}: ${recipientSummary}.`
          : `Creating event "${snapshot.title}" for recipient batch: ${recipientSummary}. Attendee invitations are disabled.`,
      );
      publishCampaignEvent(campaign.ownerId, {
        type: "campaign-progress",
        campaignId: campaign.id,
      });
      const result = await createICloudEvent({
        eventUid,
        email: account.email,
        appPassword: credentials,
        calendarHref: account.calendarHref,
        title: snapshot.title,
        location: snapshot.location,
        url: snapshot.url,
        description: snapshot.note ?? "",
        startAt: campaign.eventStartAt,
        durationMinutes: snapshot.durationMinutes,
        attendees,
        invitationMode: account.invitationMode as CalDAVMode,
      });
      calendarWriteSucceeded = true;
      const invitationAccepted = result.invitationAcceptedByServer;
      const finalStatus = attendees.length > 0
        ? "invitation-processed"
        : "event-created";
      await db.transaction(async (tx) => {
        await tx
          .update(campaignRecipientsTable)
          .set({
            status: finalStatus,
            eventHref: result.eventHref,
            errorMessage: null,
            claimedAt: null,
            processedAt: new Date(),
          })
          .where(
            and(
              eq(campaignRecipientsTable.campaignId, campaign.id),
              inArray(
                campaignRecipientsTable.id,
                members.map((member) => member.work.id),
              ),
            ),
          );
        await tx
          .update(recipientsTable)
          .set({ status: finalStatus })
          .where(
            and(
              eq(recipientsTable.ownerId, campaign.ownerId),
              inArray(
                recipientsTable.id,
                members.map((member) => member.recipient.id),
              ),
            ),
          );
        await tx
          .update(campaignsTable)
          .set({
            eventsCreated: sql`${campaignsTable.eventsCreated} + 1`,
            invitationsProcessed: sql`${campaignsTable.invitationsProcessed} + ${attendees.length}`,
            pending: sql`GREATEST(${campaignsTable.pending} - ${members.length}, 0)`,
          })
          .where(
            and(
              eq(campaignsTable.id, campaign.id),
              eq(campaignsTable.ownerId, campaign.ownerId),
            ),
          );
      });
      await finishCampaignIfComplete(campaign.id, campaign.ownerId);
      await recordActivity(
        campaign.ownerId,
        "info",
        attendees.length > 0 ? "invitation-sent" : "calendar-event-created",
        attendees.length > 0
          ? result.alreadyExists
            ? `An existing event "${snapshot.title}" with the configured attendee list was verified and counted as sent for ${recipientSummary}.`
            : `The event "${snapshot.title}" was saved successfully with ${attendees.length} attendee${attendees.length === 1 ? "" : "s"}: ${recipientSummary}. Counted as sent.${invitationAccepted ? " The CalDAV server also accepted the scheduling request." : ""}`
          : `A calendar event "${snapshot.title}" was created without adding attendees. Recipient batch: ${recipientSummary}.`,
      );
      publishCampaignEvent(campaign.ownerId, {
        type: "campaign-progress",
        campaignId: campaign.id,
      });
    } catch (error) {
      if (calendarWriteSucceeded) throw error;
      const message =
        error instanceof CalDAVError
          ? error.message
          : "The calendar request failed. Check the connection and try again.";
      await markRecipientGroupFailed(
        campaign.id,
        campaign.ownerId,
        members.map((member) => member.work),
        `Event "${snapshot.title}" failed for ${formatRecipients(members)}. ${message}`,
      );
      if (error instanceof CalDAVError && error.code === "AUTHENTICATION_FAILED") {
        await db
          .update(icloudSettingsTable)
          .set({ status: "authentication-failed", updatedAt: new Date() })
          .where(eq(icloudSettingsTable.ownerId, campaign.ownerId));
        await db
          .update(campaignsTable)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(campaignsTable.id, campaign.id));
      }
    }
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Campaign worker could not process a queued event group",
    );
  } finally {
    isRunning = false;
  }
}

async function markRecipientGroupFailed(
  campaignId: number,
  ownerId: string,
  works: ClaimedCampaignRecipient[],
  message: string,
): Promise<void> {
  if (works.length === 0) return;
  await db.transaction(async (tx) => {
    await tx
      .update(campaignRecipientsTable)
      .set({
        status: "invitation-failed",
        errorMessage: message,
        claimedAt: null,
        processedAt: new Date(),
      })
      .where(
        and(
          eq(campaignRecipientsTable.campaignId, campaignId),
          inArray(campaignRecipientsTable.id, works.map((work) => work.id)),
        ),
      );
    await tx
      .update(recipientsTable)
      .set({ status: "invitation-failed" })
      .where(
        and(
          eq(recipientsTable.ownerId, ownerId),
          inArray(
            recipientsTable.id,
            works.map((work) => work.recipient_id),
          ),
        ),
      );
    await tx
      .update(campaignsTable)
      .set({
        failed: sql`${campaignsTable.failed} + ${works.length}`,
        pending: sql`GREATEST(${campaignsTable.pending} - ${works.length}, 0)`,
      })
      .where(
        and(
          eq(campaignsTable.id, campaignId),
          eq(campaignsTable.ownerId, ownerId),
        ),
      );
  });
  await finishCampaignIfComplete(campaignId, ownerId);
  const activityMessage = works.length === 1
    ? message
    : `${message} ${works.length} recipients in this event group were marked failed.`;
  await recordActivity(ownerId, "error", "invitation-failed", activityMessage);
  publishCampaignEvent(ownerId, {
    type: "campaign-progress",
    campaignId,
  });
}

async function finishCampaignIfComplete(
  campaignId: number,
  ownerId: string,
): Promise<void> {
  const [campaign] = await db
    .select({
      status: campaignsTable.status,
      pending: campaignsTable.pending,
    })
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.ownerId, ownerId),
      ),
    )
    .limit(1);
  if (campaign?.status === "running" && campaign.pending === 0) {
    await db
      .update(campaignsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(campaignsTable.id, campaignId),
          eq(campaignsTable.ownerId, ownerId),
        ),
      );
  }
}

export function startCampaignWorker(): void {
  if (timer) return;
  void pool
    .query(
      `UPDATE campaign_recipients
       SET status = 'pending', claimed_at = NULL
       WHERE status = 'invitation-processing'
         AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')`,
    )
    .catch((error: unknown) => {
      logger.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Campaign worker could not recover an expired claim",
      );
    });
  timer = setInterval(() => {
    void processNextEventGroup();
  }, 1_000);
  timer.unref();
}