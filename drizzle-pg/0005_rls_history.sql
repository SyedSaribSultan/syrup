ALTER TABLE "chat_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "chat_sessions_tenant" ON "chat_sessions" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "messages_tenant" ON "messages" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint
ALTER TABLE "router_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "router_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "router_events_tenant" ON "router_events" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memories_tenant" ON "memories" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint
-- Full-text search: a stored tsvector over title, content and tags, with a GIN index.
ALTER TABLE "memories" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("title",'') || ' ' || coalesce("content",'') || ' ' || array_to_string("tags", ' '))) STORED;--> statement-breakpoint
CREATE INDEX "memories_search_idx" ON "memories" USING GIN ("search");
