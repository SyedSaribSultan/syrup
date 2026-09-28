CREATE TABLE "shared_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"models" text[] DEFAULT '{}' NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"redactions" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "shared_chats" ADD CONSTRAINT "shared_chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_chats" ADD CONSTRAINT "shared_chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_chats_user_idx" ON "shared_chats" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "shared_chats_session_idx" ON "shared_chats" USING btree ("user_id","session_id");--> statement-breakpoint
-- Row-level security like every tenant table: the owner lists, updates and revokes their own shares inside withUser().
ALTER TABLE "shared_chats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shared_chats" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "shared_chats_tenant" ON "shared_chats" USING ("user_id" = app_user_id()) WITH CHECK ("user_id" = app_user_id());--> statement-breakpoint
-- The public viewer has no user. It reads one share through the SECURITY DEFINER functions below, which run as
-- the role that owns them (the migration role). FORCE applies RLS to that role too unless it has BYPASSRLS
-- (Neon's owner does, a plain Postgres owner may not), so give the owning role its own policy on this table only.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY "shared_chats_definer" ON "shared_chats" FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;--> statement-breakpoint
-- One live share by id: nothing for unknown, revoked or deleted-account rows. The only public read path.
CREATE OR REPLACE FUNCTION get_shared_chat(p_id text)
RETURNS TABLE (id text, user_id text, workspace_id text, session_id text, title text, snapshot jsonb, models text[], message_count integer, bytes integer, redactions integer, views integer, created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.user_id, s.workspace_id, s.session_id, s.title, s.snapshot, s.models, s.message_count, s.bytes, s.redactions, s.views, s.created_at, s.updated_at
  FROM shared_chats s
  JOIN users u ON u.id = s.user_id
  WHERE s.id = p_id AND s.revoked_at IS NULL AND u.deleted_at IS NULL
  LIMIT 1
$$;--> statement-breakpoint
-- View counter for a live share; the only public write path.
CREATE OR REPLACE FUNCTION bump_shared_chat_views(p_id text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE shared_chats SET views = views + 1 WHERE id = p_id AND revoked_at IS NULL
$$;--> statement-breakpoint
-- Execute rights: only the app role (docs/DEPLOY.md creates syrup_app). Without that role the app connects as the
-- owner, which can always call its own functions, and the default PUBLIC grant stays (the rows are public by design).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syrup_app') THEN
    REVOKE ALL ON FUNCTION get_shared_chat(text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION bump_shared_chat_views(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION get_shared_chat(text) TO syrup_app;
    GRANT EXECUTE ON FUNCTION bump_shared_chat_views(text) TO syrup_app;
  END IF;
END $$;
