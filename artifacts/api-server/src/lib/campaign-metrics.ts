import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  campaignRecipientsTable,
  campaignsTable,
  db,
} from "@workspace/db";

type CampaignSentTotal = {
  id: number;
  invitationsProcessed: number;
};

export async function savedAttendeeCountsForCampaigns(
  ownerId: string,
  campaignIds: number[],
): Promise<Map<number, number>> {
  if (campaignIds.length === 0) return new Map();

  const rows = await db
    .select({
      campaignId: campaignRecipientsTable.campaignId,
      sentCount: count(),
    })
    .from(campaignRecipientsTable)
    .innerJoin(
      campaignsTable,
      eq(campaignRecipientsTable.campaignId, campaignsTable.id),
    )
    .where(
      and(
        eq(campaignsTable.ownerId, ownerId),
        inArray(campaignRecipientsTable.campaignId, campaignIds),
        inArray(campaignRecipientsTable.status, [
          "event-created",
          "invitation-processed",
        ]),
        isNotNull(campaignRecipientsTable.eventHref),
        sql`${campaignsTable.eventSnapshot}->>'inviteAsAttendees' = 'true'`,
      ),
    )
    .groupBy(campaignRecipientsTable.campaignId);

  return new Map(
    rows.map((row) => [row.campaignId, Number(row.sentCount)]),
  );
}

export function campaignSentCount(
  campaign: CampaignSentTotal,
  savedCounts: Map<number, number>,
): number {
  return Math.max(
    campaign.invitationsProcessed,
    savedCounts.get(campaign.id) ?? 0,
  );
}