import { and, desc, gte, inArray, like, lt, lte, or, sql } from "drizzle-orm"
import { db, dbReady, schema } from "./db"

/**
 * Structured logging for every layer of syrup. Rows are buffered and written
 * in batches so hot paths (engine events, streaming) never wait on SQLite.
 * Secrets are redacted before anything is stored.
 */

export type Level = "debug" | "info" | "warn" | "error"
export type Source = "boot" | "engine" | "router" | "mcp" | "memory" | "skills" | "providers" | "workspace" | "ledger" | "api" | "ui" | "sidecar"

export type LogRow = typeof schema.logs.$inferSelect

const RETENTION_MS = 7 * 86_400_000
const MAX_ROWS = 200_000
const FIELD_CAP = 4096

const SECRET_KEYS = /^(api[_-]?key|authorization|secret|token|password|key)$/i

/** Truncates long strings and strips anything that looks like a credential. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]"
  if (typeof value === "string") {
    const v = value.length > FIELD_CAP ? `${value.slice(0, FIELD_CAP)}… [${value.length - FIELD_CAP} more chars]` : value
    return v.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/g, "$1[redacted]").replace(/\b(AIza|gsk_|sk-|or-|nvapi-)[A-Za-z0-9_\-]{8,}/g, "$1[redacted]")
  }
  if (Array.isArray(value)) return value.length > 200 ? [...value.slice(0, 200).map((v) => redact(v, depth + 1)), `[${value.length - 200} more]`] : value.map((v) => redact(v, depth + 1))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) && typeof v === "string" ? (v.length > 8 ? `…${v.slice(-4)}` : "[redacted]") : redact(v, depth + 1)
    }
    return out
  }
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  return value
}

type Pending = typeof schema.logs.$inferInsert

const g = globalThis as unknown as { __syrupLogBuf?: Pending[]; __syrupLogTimer?: NodeJS.Timeout; __syrupLogPrune?: number }

async function flush() {
  const buf = g.__syrupLogBuf ?? []
  g.__syrupLogBuf = []
  g.__syrupLogTimer = undefined
  if (buf.length === 0) return
  try {
    await dbReady()
    // libsql handles a few hundred rows per statement comfortably.
    for (let i = 0; i < buf.length; i += 200) await db().insert(schema.logs).values(buf.slice(i, i + 200))
    const now = Date.now()
    if (!g.__syrupLogPrune || now - g.__syrupLogPrune > 3_600_000) {
      g.__syrupLogPrune = now
      await db().delete(schema.logs).where(lt(schema.logs.ts, now - RETENTION_MS))
      const [{ n }] = await db().select({ n: sql<number>`count(*)` }).from(schema.logs)
      if (n > MAX_ROWS) {
        const [cut] = await db().select({ id: schema.logs.id }).from(schema.logs).orderBy(desc(schema.logs.id)).limit(1).offset(MAX_ROWS)
        if (cut) await db().delete(schema.logs).where(lt(schema.logs.id, cut.id))
      }
    }
  } catch (err) {
    console.warn("[syrup] log flush failed", err instanceof Error ? err.message : err)
  }
}

export function slog(source: Source, event: string, data?: unknown, opts: { level?: Level; sessionId?: string | null; directory?: string | null; ts?: number } = {}) {
  const level = opts.level ?? "info"
  const row: Pending = {
    ts: opts.ts ?? Date.now(),
    level,
    source,
    event,
    sessionId: opts.sessionId ?? null,
    directory: opts.directory ?? null,
    data: data === undefined ? null : JSON.stringify(redact(data)),
  }
  ;(g.__syrupLogBuf ??= []).push(row)
  if (!g.__syrupLogTimer) g.__syrupLogTimer = setTimeout(() => void flush(), 250)
  if (level === "error" || level === "warn") {
    const fn = level === "error" ? console.error : console.warn
    fn(`[syrup:${source}] ${event}`, data instanceof Error ? data.message : "")
  }
}

/** Accepts rows posted by the browser. */
export function slogMany(rows: { ts?: number; level?: Level; source?: Source; event: string; data?: unknown; sessionId?: string | null; directory?: string | null }[]) {
  for (const r of rows.slice(0, 500)) slog(r.source ?? "ui", String(r.event).slice(0, 120), r.data, { level: r.level, sessionId: r.sessionId, directory: r.directory, ts: r.ts })
}

export type LogQuery = {
  since?: number
  until?: number
  levels?: Level[]
  sources?: Source[]
  sessionId?: string
  q?: string
  limit?: number
}

export async function queryLogs(qy: LogQuery): Promise<LogRow[]> {
  await flush()
  const l = schema.logs
  const conds = []
  if (qy.since) conds.push(gte(l.ts, qy.since))
  if (qy.until) conds.push(lte(l.ts, qy.until))
  if (qy.levels?.length) conds.push(inArray(l.level, qy.levels))
  if (qy.sources?.length) conds.push(inArray(l.source, qy.sources))
  if (qy.sessionId) conds.push(or(sql`${l.sessionId} = ${qy.sessionId}`, sql`${l.data} LIKE ${`%${qy.sessionId}%`}`))
  if (qy.q) {
    const pat = `%${qy.q}%`
    conds.push(or(like(l.event, pat), like(l.data, pat), like(l.source, pat)))
  }
  return db()
    .select()
    .from(l)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(l.ts), desc(l.id))
    .limit(Math.min(qy.limit ?? 2000, 10_000))
}

/** One greppable line per row, oldest first. */
export function formatLogs(rows: LogRow[]): string {
  return [...rows]
    .reverse()
    .map((r) => {
      const sess = r.sessionId ? ` sess=${r.sessionId}` : ""
      return `${new Date(r.ts).toISOString()}  ${r.level.toUpperCase().padEnd(5)}  ${r.source.padEnd(9)}  ${r.event}${sess}${r.data ? `  ${r.data}` : ""}`
    })
    .join("\n")
}
