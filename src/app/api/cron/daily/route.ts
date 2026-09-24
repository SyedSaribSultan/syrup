import crypto from "node:crypto"
import { Sandbox } from "@vercel/sandbox"
import { and, eq, inArray, lt, sql } from "drizzle-orm"
import { audit } from "@/server/cloud/audit"
import { pgAdmin, pgReady, pgSchema } from "@/server/db/pg"
import { slog } from "@/server/log"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const LOG_RETENTION_DAYS = 14
const DELETE_GRACE_DAYS = 30

/**
 * Nightly maintenance (vercel.json crons; Hobby allows once a day).
 * Vercel calls it with `Authorization: Bearer $CRON_SECRET`.
 * - Prunes application logs past the published retention.
 * - Fulfils account-deletion requests once the 30-day grace period is over:
 *   destroys the user's sandboxes and snapshots, then deletes the user row
 *   (every tenant table cascades). Consents and audit rows are kept by
 *   design; the user id in them no longer resolves to a person.
 * Exports still need R2 + email (PLAN §6); until then they stay queued for the admin.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
  if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  await pgReady()
  const db = pgAdmin()
  const t0 = Date.now()
  const report: Record<string, unknown> = {}

  // 1. Logs older than the retention window.
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000)
  const pruned = await db.delete(pgSchema.logs).where(lt(pgSchema.logs.ts, cutoff)).returning({ id: pgSchema.logs.id })
  report.logsPruned = pruned.length

  // 2. Deletion requests past their grace period.
  const due = new Date(Date.now() - DELETE_GRACE_DAYS * 86_400_000)
  const requests = await db.select().from(pgSchema.dataRequests).where(and(eq(pgSchema.dataRequests.type, "delete"), eq(pgSchema.dataRequests.status, "requested"), lt(pgSchema.dataRequests.requestedAt, due)))
  const deleted: string[] = []
  for (const r of requests) {
    try {
      await db.update(pgSchema.dataRequests).set({ status: "running" }).where(eq(pgSchema.dataRequests.id, r.id))
      const boxes = await db.select({ name: pgSchema.sandboxes.vercelName }).from(pgSchema.sandboxes).where(eq(pgSchema.sandboxes.userId, r.userId))
      for (const b of boxes) {
        try {
          const sb = await Sandbox.get({ name: b.name, resume: false })
          if (sb.status === "running") await sb.stop()
          await sb.delete()
        } catch {
          // never created or already gone
        }
      }
      await db.delete(pgSchema.users).where(eq(pgSchema.users.id, r.userId))
      await db.update(pgSchema.dataRequests).set({ status: "done", completedAt: new Date() }).where(eq(pgSchema.dataRequests.id, r.id))
      await audit(null, { userId: null, actor: "system", action: "account.deleted", target: r.userId, data: { sandboxes: boxes.length } })
      deleted.push(r.userId)
    } catch (err) {
      await db.update(pgSchema.dataRequests).set({ status: "failed" }).where(eq(pgSchema.dataRequests.id, r.id))
      slog("api", "cron.delete_failed", { request: r.id, err }, { level: "error" })
    }
  }
  report.accountsDeleted = deleted.length

  // 3. Soft-deleted workspaces older than the grace period: drop the rows (sandboxes were destroyed at delete time).
  const oldWs = await db.select({ id: pgSchema.workspaces.id }).from(pgSchema.workspaces).where(lt(pgSchema.workspaces.deletedAt, due))
  if (oldWs.length) await db.delete(pgSchema.workspaces).where(inArray(pgSchema.workspaces.id, oldWs.map((w) => w.id)))
  report.workspacesPurged = oldWs.length

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(pgSchema.dataRequests).where(and(eq(pgSchema.dataRequests.type, "export"), eq(pgSchema.dataRequests.status, "requested")))
  report.exportsQueued = n
  report.ms = Date.now() - t0
  slog("api", "cron.daily", report)
  return Response.json(report)
}
