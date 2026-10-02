CREATE TABLE "activity_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"event" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"recipient_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"event_href" text,
	"error_message" text,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"events_created" integer DEFAULT 0 NOT NULL,
	"invitations_processed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"event_start_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"name" text,
	"is_valid" boolean NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'Team Meeting' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"invite_as_attendees" boolean DEFAULT true NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"minimum_lead_minutes" integer DEFAULT 15 NOT NULL,
	"automatic_time_selection" boolean DEFAULT true NOT NULL,
	"start_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icloud_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"encrypted_password" text,
	"calendar_name" text DEFAULT '' NOT NULL,
	"calendar_href" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"status" text DEFAULT 'not-connected' NOT NULL,
	"invitation_mode" text DEFAULT 'calendar-only' NOT NULL,
	"calendars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_recipient_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_logs_owner_created_at" ON "activity_logs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_campaign_recipient" ON "campaign_recipients" USING btree ("campaign_id","recipient_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_campaign_status" ON "campaign_recipients" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_owner_created_at" ON "campaigns" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "campaigns_owner_status" ON "campaigns" USING btree ("owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "recipients_owner_normalized_email" ON "recipients" USING btree ("owner_id","normalized_email");--> statement-breakpoint
CREATE INDEX "recipients_owner_created_at" ON "recipients" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "recipients_owner_status" ON "recipients" USING btree ("owner_id","status");