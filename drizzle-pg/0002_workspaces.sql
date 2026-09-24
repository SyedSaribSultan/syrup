CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"vercel_name" text NOT NULL,
	"region" text DEFAULT 'fra1' NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"password_enc" text,
	"vcpus" integer DEFAULT 1 NOT NULL,
	"engine_version" text,
	"last_session_started_at" timestamp with time zone,
	"last_session_ended_at" timestamp with time zone,
	"total_session_seconds" integer DEFAULT 0 NOT NULL,
	"total_cpu_ms" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text DEFAULT 'empty' NOT NULL,
	"repo_url" text,
	"default_branch" text,
	"egress_allow" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_opened_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_workspace_idx" ON "sandboxes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sandboxes_user_idx" ON "sandboxes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspaces_user_idx" ON "workspaces" USING btree ("user_id","last_opened_at");