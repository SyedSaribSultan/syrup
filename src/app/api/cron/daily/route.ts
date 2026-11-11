import crypto from "node:crypto"
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import { audit } from "@/server/cloud/audit"
import { FORGOTTEN_DAYS } from "@/server/cloud/memory"
import { pgAdmin, pgReady, pgSchema } from "@/server/db/pg"
import { destroyVm } from "@/server/engine/sandbox"
import { slog } from "@/server/log"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const LOG_RETENTION_DAYS = 14
const DELETE_GRACE_DAYS = 30
/** A run holds a data request this long; a run killed before it finished (maxDuration) leaves it to the next one. */
const REQUEST_LEASE_MS = 10 * 60_000
/** Tries per deletion before it stays failed for the admin (who can retry it from the admin page). */
const MAX_ATTEMPTS = 3

/**
 * Nightly maintenance (vercel.json crons; Hobby allows once a day).
 * Vercel calls it with `Authorization: Bearer $CRON_SECRET`.
 * - Prunes application logs past the published retention.
 * - Fulfils account-deletion requests once the 30-day grace period is over: claims each request (a lease, so a run
 *   killed mid-way leaves it for the next run; failures are retried up to MAX_ATTEMPTS), destroys the user's sandboxes
 *   and snapshots, then deletes the user row (every tenant table cascades, the request row with it) in the same
 *   transaction as the account.deleted audit row naming the request, which is the receipt. Audit rows are kept by
 *   design; the user id in them no longer resolves to a person.
 * - Destroys VMs of deleted workspaces that the delete could not (retried every night), then purges workspace rows past
 *   the grace period whose VM is gone.
 * - Purges memories forgotten more than FORGOTTEN_DAYS ago.
 * Exports are fulfilled by hand and marked done from the admin page.
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

  // 2. Deletion requests past their grace period: requested, a run's lapsed lease (or one from before leases), or failed with tries left.
  const due = new Date(Date.now() - DELETE_GRACE_DAYS * 86_400_000)
  const dr = pgSchema.dataRequests
  const claimable = or(eq(dr.status, "requested"), and(eq(dr.status, "running"), or(isNull(dr.leaseUntil), lt(dr.leaseUntil, sql`now()`))), and(eq(dr.status, "failed"), lt(dr.attempts, MAX_ATTEMPTS)))
  const requests = await db
    .update(dr)
    .set({ status: "running", attempts: sql`${dr.attempts} + 1`, leaseUntil: sql`now() + ${`${REQUEST_LEASE_MS} milliseconds`}::interval`, lastError: null })
    .where(and(eq(dr.type, "delete"), lt(dr.requestedAt, due), claimable))
    .returning()
  const deleted: string[] = []
  for (const r of requests) {
    try {
      const boxes = await db.select({ name: pgSchema.sandboxes.vercelName, workspaceId: pgSchema.sandboxes.workspaceId }).from(pgSchema.sandboxes).where(eq(pgSchema.sandboxes.userId, r.userId))
      for (const b of boxes) if (!(await destroyVm(b.name, b.workspaceId))) throw new Error(`could not delete sandbox ${b.name}`)
      await db.transaction(async (tx) => {
        await audit(tx, { userId: null, actor: "system", action: "account.deleted", target: r.userId, data: { request: r.id, requestedAt: r.requestedAt.toISOString(), attempts: r.attempts, sandboxes: boxes.length } })
        await tx.delete(pgSchema.users).where(eq(pgSchema.users.id, r.userId))
      })
      deleted.push(r.userId)
    } catch (err) {
      await db.update(dr).set({ status: "failed", leaseUntil: null, lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500) }).where(eq(dr.id, r.id))
      slog("api", "cron.delete_failed", { request: r.id, attempts: r.attempts, err }, { level: "error" })
    }
  }
  report.accountsDeleted = deleted.length
  report.deletionsFailed = requests.length - deleted.length

  // 3. Deleted workspaces: VMs the delete could not remove are tried again; rows past the grace period whose VM is gone are purged.
  const sb = pgSchema.sandboxes
  const ws = pgSchema.workspaces
  const orphans = await db.select({ name: sb.vercelName, workspaceId: sb.workspaceId }).from(sb).innerJoin(ws, eq(ws.id, sb.workspaceId)).where(and(isNotNull(ws.deletedAt), isNull(sb.vmDeletedAt)))
  let vmsDeleted = 0
  for (const o of orphans) {
    if (!(await destroyVm(o.name, o.workspaceId))) continue
    await db.update(sb).set({ vmDeletedAt: new Date() }).where(eq(sb.workspaceId, o.workspaceId))
    vmsDeleted++
  }
  report.orphanVmsDeleted = vmsDeleted
  report.orphanVmsLeft = orphans.length - vmsDeleted
  const oldWs = await db
    .select({ id: ws.id })
    .from(ws)
    .leftJoin(sb, eq(sb.workspaceId, ws.id))
    .where(and(lt(ws.deletedAt, due), or(isNull(sb.id), isNotNull(sb.vmDeletedAt))))
  if (oldWs.length) await db.delete(ws).where(inArray(ws.id, oldWs.map((w) => w.id)))
  report.workspacesPurged = oldWs.length

  // 4. Memories forgotten long enough ago that they can no longer be restored.
  const forgottenBefore = new Date(Date.now() - FORGOTTEN_DAYS * 86_400_000)
  const purged = await db.delete(pgSchema.memories).where(lt(pgSchema.memories.deletedAt, forgottenBefore)).returning({ id: pgSchema.memories.id })
  report.memoriesPurged = purged.length

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(dr).where(and(eq(dr.type, "export"), eq(dr.status, "requested")))
  report.exportsQueued = n
  report.ms = Date.now() - t0
  slog("api", "cron.daily", report)
  return Response.json(report)
}
