import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { isAdmin } from "@/auth.config"
import { audit } from "@/server/cloud/audit"
import { forgetBlocked, handler, requireAdmin } from "@/server/cloud/session"
import { pgAdmin, pgReady, pgSchema } from "@/server/db/pg"
import { stopWorkspace } from "@/server/engine/sandbox"
import { env } from "@/server/env"

export const dynamic = "force-dynamic"

/** Users, their key counts, open data requests and the admin list. Admin only. */
export const GET = handler(async () => {
  await requireAdmin()
  await pgReady()
  // Cross-tenant aggregates: the owner connection bypasses RLS on purpose (admin only).
  const db = pgAdmin()
  const users = await db.select({ id: pgSchema.users.id, email: pgSchema.users.email, name: pgSchema.users.name, createdAt: pgSchema.users.createdAt, lastSeenAt: pgSchema.users.lastSeenAt, analyticsOptOut: pgSchema.users.analyticsOptOut, deletedAt: pgSchema.users.deletedAt, blockedAt: pgSchema.users.blockedAt }).from(pgSchema.users).orderBy(desc(pgSchema.users.createdAt)).limit(500)
  // Aggregates bypass RLS on purpose: set the scope to a sentinel and count with plain SQL as owner.
  const keyCounts = await db.execute<{ user_id: string; n: number }>(sql`select user_id, count(*)::int as n from provider_keys group by user_id`)
  const openRequests = await db.execute<{ id: string; user_id: string; type: string; status: string; requested_at: string }>(sql`select id, user_id, type, status, requested_at from data_requests where status in ('requested','running') order by requested_at asc`)
  const consents = await db.execute<{ user_id: string; kind: string }>(sql`select distinct on (user_id, kind) user_id, kind from consents where revoked_at is null order by user_id, kind, granted_at desc`)
  const keys = Object.fromEntries(keyCounts.rows.map((r) => [r.user_id, r.n]))
  const research = new Set(consents.rows.filter((r) => r.kind === "research").map((r) => r.user_id))
  return Response.json({
    users: users.map((u) => ({ ...u, keys: keys[u.id] ?? 0, research: research.has(u.id) })),
    openRequests: openRequests.rows,
    adminEmails: env.adminEmails,
  })
})

const Block = z.object({ userId: z.string().min(1).max(100), blocked: z.boolean() })

/**
 * Block or unblock an account. A blocked user can't sign in, every API call
 * gets a 403 within a minute, and their running sandboxes stop now (the
 * browser talks to a sandbox directly, so stopping it is what ends a live chat).
 */
export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin()
  const parsed = Block.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "userId and blocked are required" }, { status: 400 })
  await pgReady()
  const db = pgAdmin()
  const u = pgSchema.users
  const [user] = await db.select({ id: u.id, email: u.email }).from(u).where(eq(u.id, parsed.data.userId))
  if (!user) return Response.json({ error: "no such user" }, { status: 404 })
  if (isAdmin(user.email)) return Response.json({ error: "admins can't be blocked" }, { status: 400 })
  await db.update(u).set({ blockedAt: parsed.data.blocked ? new Date() : null }).where(eq(u.id, user.id))
  forgetBlocked(user.id)
  let stopped = 0
  if (parsed.data.blocked) {
    const sb = pgSchema.sandboxes
    const boxes = await db.select({ workspaceId: sb.workspaceId }).from(sb).where(and(eq(sb.userId, user.id), inArray(sb.status, ["running", "starting"])))
    for (const b of boxes) {
      try {
        if (await stopWorkspace(user.id, b.workspaceId)) stopped++
      } catch {
        // already gone
      }
    }
  }
  await audit(null, { userId: admin.id, actor: "admin", action: parsed.data.blocked ? "user.block" : "user.unblock", target: user.email, data: { stopped } })
  return Response.json({ ok: true, stopped })
})
