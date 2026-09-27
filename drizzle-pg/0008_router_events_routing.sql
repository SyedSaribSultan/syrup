ALTER TABLE "router_events" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "router_events" ADD COLUMN "ttft_ms" integer;--> statement-breakpoint
ALTER TABLE "router_events" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "router_events" ADD COLUMN "reason" text;--> statement-breakpoint
CREATE INDEX "router_events_session_idx" ON "router_events" USING btree ("user_id","session_id");