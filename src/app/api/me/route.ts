import { desc, eq } from "drizzle-orm"
import { z } from "zod"
import { setOptOut, track } from "@/server/analytics"
import { audit } from "@/server/cloud/audit"
import { ipHash } from "@/server/cloud/crypto"
import { currentConsents, recordConsent, revokeConsent } from "@/server/cloud/legal"
import { handler, requireUser } from "@/server/cloud/session"
import { pg, pgReady, pgSchema, withUser } from "@/server/db/pg"

export const dynamic = "force-dynamic"

/** The signed-in user's account, privacy choices and open data requests. */
export const GET = handler(async () => {
  const me = await requireUser()
  await pgReady()
  const [user] = await pg().select({ email: pgSchema.users.email, name: pgSchema.users.name, analyticsOptOut: pgSchema.users.analyticsOptOut, createdAt: pgSchema.users.createdAt }).from(pgSchema.users).where(eq(pgSchema.users.id, me.id))
  if (!user) throw Response.json({ error: "account not found" }, { status: 404 })
  setOptOut(me.id, user.analyticsOptOut)
  const [consents, requests] = await Promise.all([
    currentConsents(me.id),
    withUser(me.id, (tx) => tx.select().from(pgSchema.dataRequests).where(eq(pgSchema.dataRequests.userId, me.id)).orderBy(desc(pgSchema.dataRequests.requestedAt)).limit(10)),
  ])
  return Response.json({ id: me.id, email: user.email, name: user.name, admin: me.admin, createdAt: user.createdAt, analyticsOptOut: user.analyticsOptOut, consents, requests })
})

const Patch = z.object({
  analyticsOptOut: z.boolean().optional(),
  research: z.boolean().optional(),
})

function meta(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")
  return { ipHash: ipHash(ip), userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null }
}

export const PATCH = handler(async (req: Request) => {
  const me = await requireUser()
  const parsed = Patch.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 })
  const m = meta(req)
  await pgReady()
  if (parsed.data.analyticsOptOut !== undefined) {
    await pg().update(pgSchema.users).set({ analyticsOptOut: parsed.data.analyticsOptOut }).where(eq(pgSchema.users.id, me.id))
    setOptOut(me.id, parsed.data.analyticsOptOut)
    await audit(null, { userId: me.id, actor: "user", action: parsed.data.analyticsOptOut ? "analytics.opt_out" : "analytics.opt_in", ipHash: m.ipHash })
  }
  if (parsed.data.research !== undefined) {
    if (parsed.data.research) await recordConsent(me.id, ["research"], m)
    else await revokeConsent(me.id, "research", m)
    await track(me.id, parsed.data.research ? "research_consent_granted" : "research_consent_revoked")
  }
  return Response.json({ ok: true })
})
