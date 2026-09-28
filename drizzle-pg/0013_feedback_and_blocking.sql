CREATE TABLE "message_feedback" (
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"session_id" text NOT NULL,
	"rating" smallint NOT NULL,
	"alias" text,
	"provider_id" text,
	"model_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_feedback_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_feedback_session_idx" ON "message_feedback" USING btree ("user_id","session_id");--> statement-breakpoint
ALTER TABLE "message_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_feedback_tenant" ON "message_feedback" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());