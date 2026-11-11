import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { audit } from "@/server/cloud/audit"
import { handler, requireAdmin } from "@/server/cloud/session"
import { pgAdmin, pgReady, pgSchema } from "@/server/db/pg"

export const dynamic = "force-dynamic"

const Body = z.object({ id: z.string().min(1).max(100), action: z.enum(["done", "retry"]) })

/**
 * Admin actions on a data request. "done": an export fulfilled by hand. "retry": a deletion that failed every nightly
 * try goes back to requested (attempts reset), so the next cron run takes it again. Each is one conditional write.
 */
export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin()
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "id and action are required" }, { status: 400 })
  await pgReady()
  const dr = pgSchema.dataRequests
  const { id, action } = parsed.data
  const rows =
    action === "done"
      ? await pgAdmin().update(dr).set({ status: "done", completedAt: new Date() }).where(and(eq(dr.id, id), eq(dr.type, "export"), eq(dr.status, "requested"))).returning({ id: dr.id })
      : await pgAdmin().update(dr).set({ status: "requested", attempts: 0, lastError: null, leaseUntil: null }).where(and(eq(dr.id, id), eq(dr.status, "failed"))).returning({ id: dr.id })
  if (!rows.length) return Response.json({ error: action === "done" ? "Only an open export can be marked done." : "Only a failed request can be retried." }, { status: 409 })
  await audit(null, { userId: admin.id, actor: "admin", action: `data_request.${action}`, target: id })
  return Response.json({ ok: true })
})
