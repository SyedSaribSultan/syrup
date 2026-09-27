ALTER TABLE "workspaces" ADD COLUMN "color" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing live workspaces get distinct colors in creation order (runs as the owner role, which bypasses RLS).
UPDATE "workspaces" w SET "color" = r.c
FROM (SELECT "id", (row_number() OVER (PARTITION BY "user_id" ORDER BY "created_at") - 1) % 8 AS c FROM "workspaces" WHERE "deleted_at" IS NULL) r
WHERE w."id" = r."id";
