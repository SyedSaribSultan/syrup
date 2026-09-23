import { desc, sql } from "drizzle-orm"
import { handler, requireAdmin } from "@/server/cloud/session"
import { pg, pgReady, pgSchema } from "@/server/db/pg"

export const dynamic = "force-dynamic"

/** Users, their key counts and open data requests. Admin only. */
export const GET = handler(async () => {
  await requireAdmin()
  await pgReady()
  const db = pg()
  const users = await db.select({ id: pgSchema.users.id, email: pgSchema.users.email, name: pgSchema.users.name, createdAt: pgSchema.users.createdAt, lastSeenAt: pgSchema.users.lastSeenAt, analyticsOptOut: pgSchema.users.analyticsOptOut, deletedAt: pgSchema.users.deletedAt }).from(pgSchema.users).orderBy(desc(pgSchema.users.createdAt)).limit(500)
  // Aggregates bypass RLS on purpose: set the scope to a sentinel and count with plain SQL as owner.
  const keyCounts = await db.execute<{ user_id: string; n: number }>(sql`select user_id, count(*)::int as n from provider_keys group by user_id`)
  const openRequests = await db.execute<{ id: string; user_id: string; type: string; status: string; requested_at: string }>(sql`select id, user_id, type, status, requested_at from data_requests where status in ('requested','running') order by requested_at asc`)
  const consents = await db.execute<{ user_id: string; kind: string }>(sql`select distinct on (user_id, kind) user_id, kind from consents where revoked_at is null order by user_id, kind, granted_at desc`)
  const keys = Object.fromEntries(keyCounts.rows.map((r) => [r.user_id, r.n]))
  const research = new Set(consents.rows.filter((r) => r.kind === "research").map((r) => r.user_id))
  return Response.json({
    users: users.map((u) => ({ ...u, keys: keys[u.id] ?? 0, research: research.has(u.id) })),
    openRequests: openRequests.rows,
  })
})
