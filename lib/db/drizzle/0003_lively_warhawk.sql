CREATE TABLE "app_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"normalized_username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "app_users_role_check" CHECK ("app_users"."role" in ('admin', 'user'))
);
--> statement-breakpoint
CREATE TABLE "auth_login_attempts" (
	"bucket_hash" text PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone,
	CONSTRAINT "auth_login_attempts_nonnegative" CHECK ("auth_login_attempts"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "event_settings" ADD COLUMN "invitees_per_event" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_sessions_token_hash_unique" ON "app_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_normalized_username_unique" ON "app_users" USING btree ("normalized_username");--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_single_admin" ON "app_users" USING btree ("role") WHERE "app_users"."role" = 'admin';