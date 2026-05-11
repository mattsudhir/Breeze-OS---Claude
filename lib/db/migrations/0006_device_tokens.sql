-- Push notification device registrations. One row per (user, device)
-- pair. The token is the platform-specific identifier Firebase Cloud
-- Messaging hands back after registration; FCM proxies to APNs for
-- iOS so we never store APNs tokens directly.

CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android', 'web');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "device_tokens" (
  "id"               uuid                       PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"  uuid                       NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"          uuid                       REFERENCES "users"("id") ON DELETE CASCADE,
  "platform"         "public"."device_platform" NOT NULL,
  "token"            text                       NOT NULL,
  "device_model"     text,
  "app_version"      text,
  "locale"           text,
  "last_seen_at"     timestamptz                NOT NULL DEFAULT now(),
  "created_at"       timestamptz                NOT NULL DEFAULT now(),
  CONSTRAINT "device_tokens_token_unique" UNIQUE ("token")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "device_tokens_org_idx"  ON "device_tokens" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_tokens_user_idx" ON "device_tokens" ("user_id");
