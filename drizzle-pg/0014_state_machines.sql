ALTER TABLE "data_requests" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_requests" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_requests" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "start_owner" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "start_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "idle_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "skills_reload_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "vm_deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "data_requests_open_idx" ON "data_requests" USING btree ("user_id","type") WHERE "data_requests"."status" in ('requested', 'running');