CREATE TABLE "user_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"files" jsonb NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_skills_user_name_idx" ON "user_skills" USING btree ("user_id","name");--> statement-breakpoint
ALTER TABLE "user_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_skills_tenant" ON "user_skills" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());
