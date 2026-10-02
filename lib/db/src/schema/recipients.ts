import {
  boolean,
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recipientsTable = pgTable(
  "recipients",
  {
    id: serial("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    name: text("name"),
    isValid: boolean("is_valid").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("recipients_owner_normalized_email").on(
      table.ownerId,
      table.normalizedEmail,
    ),
    index("recipients_owner_created_at").on(table.ownerId, table.createdAt),
    index("recipients_owner_status").on(table.ownerId, table.status),
  ],
);

export const insertRecipientSchema = createInsertSchema(recipientsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertRecipient = z.infer<typeof insertRecipientSchema>;
export type Recipient = typeof recipientsTable.$inferSelect;