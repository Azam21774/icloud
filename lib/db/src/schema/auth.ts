import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const appUsersTable = pgTable(
  "app_users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    normalizedUsername: text("normalized_username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("app_users_normalized_username_unique").on(
      table.normalizedUsername,
    ),
    uniqueIndex("app_users_single_admin").on(table.role).where(
      sql`${table.role} = 'admin'`,
    ),
    check("app_users_role_check", sql`${table.role} in ('admin', 'user')`),
  ],
);

export const appSessionsTable = pgTable(
  "app_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => appUsersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_sessions_token_hash_unique").on(table.tokenHash),
  ],
);

export const authLoginAttemptsTable = pgTable(
  "auth_login_attempts",
  {
    bucketHash: text("bucket_hash").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  },
  (table) => [
    check("auth_login_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
);

export const insertAppUserSchema = createInsertSchema(appUsersTable).omit({
  createdAt: true,
  lastLoginAt: true,
});
export type InsertAppUser = z.infer<typeof insertAppUserSchema>;
export type AppUser = typeof appUsersTable.$inferSelect;

export const insertAppSessionSchema = createInsertSchema(
  appSessionsTable,
).omit({ createdAt: true });
export type InsertAppSession = z.infer<typeof insertAppSessionSchema>;
export type AppSession = typeof appSessionsTable.$inferSelect;

export const insertAuthLoginAttemptSchema = createInsertSchema(
  authLoginAttemptsTable,
);
export type InsertAuthLoginAttempt = z.infer<
  typeof insertAuthLoginAttemptSchema
>;