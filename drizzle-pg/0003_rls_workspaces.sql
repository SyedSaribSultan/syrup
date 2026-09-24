ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspaces_tenant" ON "workspaces" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint
ALTER TABLE "sandboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandboxes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sandboxes_tenant" ON "sandboxes" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());
