import { index, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const activityLogsTable = pgTable(
  "activity_logs",
  {
    id: serial("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    level: text("level").notNull().default("info"),
    event: text("event").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("activity_logs_owner_created_at").on(table.ownerId, table.createdAt),
  ],
);

export const insertActivityLogSchema = createInsertSchema(
  activityLogsTable,
).omit({ id: true, createdAt: true });

export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogsTable.$inferSelect;