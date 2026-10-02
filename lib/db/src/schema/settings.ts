import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type CalendarOption = {
  href: string;
  name: string;
  description?: string;
};

export const icloudSettingsTable = pgTable("icloud_settings", {
  ownerId: text("owner_id").primaryKey(),
  email: text("email").notNull().default(""),
  // Keep the legacy database column name; new values are stored as plaintext.
  appPassword: text("encrypted_password"),
  calendarName: text("calendar_name").notNull().default(""),
  calendarHref: text("calendar_href").notNull().default(""),
  timezone: text("timezone").notNull().default("America/New_York"),
  status: text("status").notNull().default("not-connected"),
  invitationMode: text("invitation_mode").notNull().default("calendar-only"),
  calendars: jsonb("calendars")
    .$type<CalendarOption[]>()
    .notNull()
    .default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const eventSettingsTable = pgTable("event_settings", {
  ownerId: text("owner_id").primaryKey(),
  title: text("title").notNull().default("Team Meeting"),
  location: text("location").notNull().default(""),
  description: text("description").notNull().default(""),
  url: text("url").notNull().default(""),
  note: text("note").notNull().default(""),
  inviteAsAttendees: boolean("invite_as_attendees").notNull().default(true),
  inviteesPerEvent: integer("invitees_per_event").notNull().default(1),
  timezone: text("timezone").notNull().default("America/New_York"),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  minimumLeadMinutes: integer("minimum_lead_minutes").notNull().default(15),
  automaticTimeSelection: boolean("automatic_time_selection")
    .notNull()
    .default(true),
  startAt: timestamp("start_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertEventSettingsSchema = createInsertSchema(
  eventSettingsTable,
).omit({ updatedAt: true });

export type InsertEventSettings = z.infer<typeof insertEventSettingsSchema>;
export type EventSettings = typeof eventSettingsTable.$inferSelect;