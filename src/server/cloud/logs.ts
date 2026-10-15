import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm"
import { ulid } from "ulid"
import { pg, pgReady, pgSchema } from "../db/pg"
import type { LogQuery } from "../log"
import { redact } from "../log"
import { env } from "../env"

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

/**
 * Caps one row's `data` at env.logDataMaxBytes serialized (audit 2026-10-15 H2): a bigger value is replaced by a
 * marker with its size and the start of its JSON, so the row still says what happened without filling the database.
 */
export function capLogData<T>(data: T): T | { truncated: true; bytes: number; preview: string } {
  const max = env.logDataMaxBytes
  if (max <= 0 || data === undefined) return data
  let json: string
  try {
    json = JSON.stringify(data) ?? ""
  } catch {
    return { truncated: true, bytes: -1, preview: "" }
  }
  const bytes = Buffer.byteLength(json)
  if (bytes <= max) return data
  return { truncated: true, bytes, preview: json.slice(0, Math.max(0, max - 200)) }
}

// Per-user token bucket for browser log rows. Per server instance: it stops one tab flooding, not a fleet.
const g = globalThis as unknown as { __syrupLogBuckets?: Map<string, { tokens: number; at: number }> }
const buckets = (g.__syrupLogBuckets ??= new Map())

/** Takes `rows` tokens from the user's bucket (env.logRowsPerMinute per minute, burst of one minute). False when empty. */
export function takeLogBudget(userId: string, rows: number): boolean {
  const perMin = env.logRowsPerMinute
  if (perMin <= 0) return true
  const now = Date.now()
  const b = buckets.get(userId) ?? { tokens: perMin, at: now }
  b.tokens = Math.min(perMin, b.tokens + ((now - b.at) / 60_000) * perMin)
  b.at = now
  if (buckets.size > 10_000) buckets.clear()
  buckets.set(userId, b)
  if (b.tokens < rows) return false
  b.tokens -= rows
  return true
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
        data: capLogData({ ...(typeof r.data === "object" && r.data ? (redact(r.data) as object) : r.data === undefined ? {} : { value: redact(r.data) }), sessionId: r.sessionId ?? undefined }),
      })),
    )
}
