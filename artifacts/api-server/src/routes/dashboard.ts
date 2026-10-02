import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  campaignsTable,
  db,
  recipientsTable,
} from "@workspace/db";
import { GetDashboardResponse, SendInvitationsResponse } from "@workspace/api-zod";
import {
  campaignSentCount,
  savedAttendeeCountsForCampaigns,
} from "../lib/campaign-metrics";
import { getOwnerId } from "../middlewares/workspace";

const router: IRouter = Router();
const ACTIVE_STATUSES = ["queued", "running", "paused"];

function invitationSendForApi(
  campaign: typeof campaignsTable.$inferSelect,
  sentCount = campaign.invitationsProcessed,
) {
  return SendInvitationsResponse.parse({
    id: campaign.id,
    status: campaign.status,
    total: campaign.total,
    eventsSaved: campaign.eventsCreated,
    sent: sentCount,
    failed: campaign.failed,
    pending: campaign.pending,
    createdAt: campaign.createdAt.toISOString(),
  });
}

router.get("/dashboard", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const [recipientCounts] = await db
      .select({
        total: count(),
        valid: sql<number>`count(*) filter (where ${recipientsTable.isValid})`,
        invalid: sql<number>`count(*) filter (where not ${recipientsTable.isValid})`,
      })
      .from(recipientsTable)
      .where(eq(recipientsTable.ownerId, ownerId));
    const [activeSend] = await db
      .select()
      .from(campaignsTable)
      .where(
        and(
          eq(campaignsTable.ownerId, ownerId),
          inArray(campaignsTable.status, ACTIVE_STATUSES),
        ),
      )
      .orderBy(desc(campaignsTable.createdAt))
      .limit(1);
    const sentCounts = activeSend
      ? await savedAttendeeCountsForCampaigns(ownerId, [activeSend.id])
      : new Map<number, number>();
    const sentCount = activeSend
      ? campaignSentCount(activeSend, sentCounts)
      : 0;
    res.json(
      GetDashboardResponse.parse({
        totalRecipients: recipientCounts?.total ?? 0,
        validRecipients: Number(recipientCounts?.valid ?? 0),
        invalidRecipients: Number(recipientCounts?.invalid ?? 0),
        activeSend:
          activeSend && ACTIVE_STATUSES.includes(activeSend.status)
            ? invitationSendForApi(activeSend, sentCount)
            : null,
      }),
    );
  } catch (error) {
    next(error);
  }
});

export default router;