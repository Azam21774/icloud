import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { recipientsTable } from "./recipients";

export const campaignsTable = pgTable(
  "campaigns",
  {
    id: serial("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("queued"),
    total: integer("total").notNull().default(0),
    eventsCreated: integer("events_created").notNull().default(0),
    invitationsProcessed: integer("invitations_processed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    pending: integer("pending").notNull().default(0),
    eventStartAt: timestamp("event_start_at", { withTimezone: true }),
    eventSnapshot: jsonb("event_snapshot")
      .$type<{
        title: string;
        location: string;
        url: string;
        note: string;
        inviteAsAttendees: boolean;
        inviteesPerEvent: number;
        timezone: string;
        durationMinutes: number;
        restartGeneration?: number;
        runType?: "one-time-send";
      }>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("campaigns_owner_created_at").on(table.ownerId, table.createdAt),
    index("campaigns_owner_status").on(table.ownerId, table.status),
    uniqueIndex("campaigns_one_active_per_owner")
      .on(table.ownerId)
      .where(sql`${table.status} in ('queued', 'running', 'paused')`),
  ],
);

export const campaignRecipientsTable = pgTable(
  "campaign_recipients",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id").notNull(),
    recipientId: integer("recipient_id").notNull(),
    status: text("status").notNull().default("pending"),
    eventHref: text("event_href"),
    errorMessage: text("error_message"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [campaignsTable.id],
      name: "campaign_recipients_campaign_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.recipientId],
      foreignColumns: [recipientsTable.id],
      name: "campaign_recipients_recipient_id_fk",
    }).onDelete("cascade"),
    uniqueIndex("campaign_recipients_campaign_recipient").on(
      table.campaignId,
      table.recipientId,
    ),
    index("campaign_recipients_campaign_status").on(
      table.campaignId,
      table.status,
    ),
  ],
);

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
export type CampaignRecipient = typeof campaignRecipientsTable.$inferSelect;