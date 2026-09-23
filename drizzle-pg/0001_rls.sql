-- Row-level security for tenant tables (docs/PLAN.md §3.2).
-- The app runs every tenant query inside a transaction that first calls
-- set_config('app.user_id', <id>, true). Outside such a transaction the
-- setting is NULL and the policies match nothing: forgotten scoping fails
-- closed. FORCE makes the policies apply to the table owner too, which is
-- the role the Vercel/Neon integration connects as.

CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;
--> statement-breakpoint
ALTER TABLE "user_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_keys_tenant" ON "user_keys" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint

ALTER TABLE "provider_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "provider_keys_tenant" ON "provider_keys" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint

ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "consents_tenant" ON "consents" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint

ALTER TABLE "data_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "data_requests_tenant" ON "data_requests" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());
