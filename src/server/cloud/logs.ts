import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm"
import { ulid } from "ulid"
import { pg, pgReady, pgSchema } from "../db/pg"
import type { LogQuery } from "../log"
import { redact } from "../log"

/**
 * Logs in cloud mode: the user's own rows (app + sidecar + browser), in the
 * same shape the Logs modal expects from local mode. The logs table is not
 * tenant-scoped by RLS (admins read across users), so this module filters by
 * user id explicitly.
 */

export type CloudLogRow = { id: string; ts: number; level: string; source: string; event: string; sessionId: string | null; directory: string | null; data: string | null }

export async function queryCloudLogs(userId: string, qy: LogQuery & { workspaceId?: string }): Promise<CloudLogRow[]> {
  await pgReady()
  const l = pgSchema.logs
  const conds = [eq(l.userId, userId)]
  if (qy.workspaceId) conds.push(eq(l.workspaceId, qy.workspaceId))
  if (qy.since) conds.push(gte(l.ts, new Date(qy.since)))
  if (qy.until) conds.push(lte(l.ts, new Date(qy.until)))
  if (qy.levels?.length) conds.push(inArray(l.level, qy.levels))
  if (qy.sources?.length) conds.push(inArray(l.source, qy.sources))
  if (qy.sessionId) conds.push(sql`${l.data}::text ILIKE ${`%${qy.sessionId}%`}`)
  if (qy.q) {
    const pat = `%${qy.q}%`
    conds.push(or(sql`${l.event} ILIKE ${pat}`, sql`${l.data}::text ILIKE ${pat}`, sql`${l.source} ILIKE ${pat}`)!)
  }
  const rows = await pg()
    .select()
    .from(l)
    .where(and(...conds))
    .orderBy(desc(l.ts), desc(l.id))
    .limit(Math.min(qy.limit ?? 2000, 10_000))
  return rows.map((r) => {
    const d = (r.data ?? null) as Record<string, unknown> | null
    return { id: r.id, ts: r.ts.getTime(), level: r.level, source: r.source, event: r.event, sessionId: (d?.sessionId as string) ?? null, directory: r.workspaceId, data: d ? JSON.stringify(d) : null }
  })
}

export async function insertCloudLogs(userId: string, rows: { ts?: number; level?: string; source?: string; event: string; data?: unknown; sessionId?: string | null; directory?: string | null }[]): Promise<void> {
  if (!rows.length) return
  await pgReady()
  await pg()
    .insert(pgSchema.logs)
    .values(
      rows.slice(0, 500).map((r) => ({
        id: ulid(),
        ts: new Date(r.ts ?? Date.now()),
        level: r.level ?? "info",
        source: r.source ?? "ui",
        event: String(r.event).slice(0, 120),
        userId,
        workspaceId: r.directory ?? null,
        data: { ...(typeof r.data === "object" && r.data ? (redact(r.data) as object) : r.data === undefined ? {} : { value: redact(r.data) }), sessionId: r.sessionId ?? undefined },
      })),
    )
}
