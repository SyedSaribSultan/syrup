import { and, eq, inArray } from "drizzle-orm"
import { ulid } from "ulid"
import { z } from "zod"
import { track } from "@/server/analytics"
import { audit } from "@/server/cloud/audit"
import { ipHash } from "@/server/cloud/crypto"
import { handler, requireUser } from "@/server/cloud/session"
import { pgSchema, withUser } from "@/server/db/pg"

export const dynamic = "force-dynamic"

const Body = z.object({ type: z.enum(["export", "delete"]) })

/**
 * Records an export or deletion request (PLAN §6 rights plumbing). The job that
 * fulfils them lands in Phase 3; until then the admin page shows the queue and
 * requests are handled by hand within the published timeframe.
 */
export const POST = handler(async (req: Request) => {
  const me = await requireUser()
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "type must be export or delete" }, { status: 400 })
  const ip = ipHash(req.headers.get("x-forwarded-for")?.split(",")[0]?.trim())
  const row = await withUser(me.id, async (tx) => {
    const open = await tx.select({ id: pgSchema.dataRequests.id }).from(pgSchema.dataRequests).where(and(eq(pgSchema.dataRequests.userId, me.id), eq(pgSchema.dataRequests.type, parsed.data.type), inArray(pgSchema.dataRequests.status, ["requested", "running"])))
    if (open.length) return null
    const [r] = await tx.insert(pgSchema.dataRequests).values({ id: ulid(), userId: me.id, type: parsed.data.type }).returning()
    await audit(tx, { userId: me.id, actor: "user", action: `data_request.${parsed.data.type}`, target: r.id, ipHash: ip })
    return r
  })
  await track(me.id, "data_request_created", { type: parsed.data.type, duplicate: !row })
  return Response.json({ ok: true, request: row, duplicate: !row })
})
