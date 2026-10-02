ALTER TABLE "campaign_recipients" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "event_snapshot" jsonb NOT NULL;