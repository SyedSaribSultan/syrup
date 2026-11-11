import { and, eq } from "drizzle-orm"
import { ulid } from "ulid"
import { z } from "zod"
import { track } from "@/server/analytics"
import { audit } from "@/server/cloud/audit"
import { ipHash } from "@/server/cloud/crypto"
import { forgetRelayKeys } from "@/server/cloud/keys"
import { forgetBlocked, handler, requireUser } from "@/server/cloud/session"
import { pgSchema, withUser } from "@/server/db/pg"
import { stopAllWorkspaces } from "@/server/engine/sandbox"

export const dynamic = "force-dynamic"

const Body = z.object({ type: z.enum(["export", "delete"]) })

/**
 * Records an export or deletion request (PLAN §6 rights plumbing). One open request per type: the partial unique index
 * data_requests_open_idx makes a second one a no-op, even when two arrive at once. A deletion request deactivates the
 * account at once (users.deleted_at: sign-in and every API call refused, workspaces stopped, left out of counts and
 * research exports); the nightly cron deletes it after the grace period. Exports are fulfilled by hand and marked done
 * from the admin page.
 */
export const POST = handler(async (req: Request) => {
  const me = await requireUser()
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "type must be export or delete" }, { status: 400 })
  const ip = ipHash(req.headers.get("x-forwarded-for")?.split(",")[0]?.trim())
  const type = parsed.data.type
  const row = await withUser(me.id, async (tx) => {
    const [r] = await tx.insert(pgSchema.dataRequests).values({ id: ulid(), userId: me.id, type }).onConflictDoNothing().returning()
    if (!r) return null
    if (type === "delete") await tx.update(pgSchema.users).set({ deletedAt: new Date() }).where(eq(pgSchema.users.id, me.id))
    await audit(tx, { userId: me.id, actor: "user", action: `data_request.${type}`, target: r.id, ipHash: ip })
    return r
  })
  await track(me.id, "data_request_created", { type, duplicate: !row })
  if (row && type === "delete") {
    forgetBlocked(me.id)
    forgetRelayKeys(me.id)
    await stopAllWorkspaces(me.id)
  }
  return Response.json({ ok: true, request: row, duplicate: !row })
})

/**
 * Cancels an export request that has not started (`?id=`). A deletion cannot be cancelled: the account is deactivated
 * the moment it is requested, as the confirm dialog says.
 */
export const DELETE = handler(async (req: Request) => {
  const me = await requireUser()
  const id = new URL(req.url).searchParams.get("id") ?? ""
  const dr = pgSchema.dataRequests
  const done = await withUser(me.id, async (tx) => {
    const r = await tx
      .update(dr)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(and(eq(dr.id, id), eq(dr.userId, me.id), eq(dr.type, "export"), eq(dr.status, "requested")))
      .returning({ id: dr.id })
    if (r.length) await audit(tx, { userId: me.id, actor: "user", action: "data_request.cancel", target: id })
    return r.length > 0
  })
  if (!done) return Response.json({ error: "Only an export that has not started can be cancelled." }, { status: 409 })
  return Response.json({ ok: true })
})
