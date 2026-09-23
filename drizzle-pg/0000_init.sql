CREATE TABLE "accounts" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"data" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"legal_document_id" text NOT NULL,
	"kind" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_hash" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "data_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"download_url_enc" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"invited_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"user_id" text,
	"workspace_id" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"secret_enc" text NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"user_id" text PRIMARY KEY NOT NULL,
	"dek_wrapped" text NOT NULL,
	"wrap_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"analytics_opt_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_legal_document_id_legal_documents_id_fk" FOREIGN KEY ("legal_document_id") REFERENCES "public"."legal_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "consents_user_kind_idx" ON "consents" USING btree ("user_id","kind","granted_at");--> statement-breakpoint
CREATE INDEX "data_requests_user_idx" ON "data_requests" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_email_idx" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_kind_version_idx" ON "legal_documents" USING btree ("kind","version");--> statement-breakpoint
CREATE INDEX "logs_ts_idx" ON "logs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "logs_user_idx" ON "logs" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "provider_keys_user_idx" ON "provider_keys" USING btree ("user_id","provider_id");