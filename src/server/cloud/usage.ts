import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm"
import { pgSchema, withUser } from "../db/pg"

/**
 * The Usage page's numbers for one cloud user, from Postgres (RLS scoped).
 * Same JSON shape as the local route, which reads SQLite usage_events and router_events.
 * Engine messages come from `messages` (assistant rows only, like the local ledger); router attempts from `router_events`.
 */

export type Sums = {
  messages: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  freeTokens: number
  paidTokens: number
}

export type RSums = {
  requests: number
  ok: number
  rateLimited: number
  errors: number
  input: number
  output: number
  cost: number
  avgLatency: number
  timeouts: number
  avgTtft: number | null
}

export type CloudUsage = {
  days: number
  since: number
  totals: Sums
  byModel: (Sums & { providerId: string | null; modelId: string | null; free: number })[]
  byDay: (Sums & { day: string })[]
  bySession: (Sums & { sessionId: string; last: number; workspaceId: string; title: string | null })[]
  routed: { totals: RSums; byBackend: (RSums & { alias: string; providerId: string; modelId: string; tier: string })[] }
}

type Raw = Record<string, unknown>

const SUM_KEYS = ["messages", "input", "output", "reasoning", "cacheRead", "cacheWrite", "cost", "freeTokens", "paidTokens"] as const
const RSUM_KEYS = ["requests", "ok", "rateLimited", "errors", "input", "output", "cost", "avgLatency", "timeouts"] as const

/** Postgres hands back bigint and numeric as strings; everything numeric leaves here as a number. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function nullableNum(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function sums(r: Raw | undefined): Sums {
  const out = {} as Sums
  for (const k of SUM_KEYS) out[k] = num(r?.[k])
  return out
}

function rsums(r: Raw | undefined): RSums {
  const out = {} as RSums
  for (const k of RSUM_KEYS) out[k] = num(r?.[k])
  out.avgTtft = nullableNum(r?.avgTtft)
  return out
}

function text(v: unknown): string | null {
  return v == null ? null : String(v)
}

/** Pure: turns the aggregate rows into the local route's JSON shape. Key order matches the local route. */
export function shapeUsage(
  days: number,
  since: number,
  raw: { totals: Raw | undefined; byModel: Raw[]; byDay: Raw[]; bySession: Raw[]; routedTotals: Raw | undefined; routedByBackend: Raw[] },
): CloudUsage {
  return {
    days,
    since,
    totals: sums(raw.totals),
    byModel: raw.byModel.map((r) => ({ providerId: text(r.providerId), modelId: text(r.modelId), free: r.free === true || r.free === 1 ? 1 : 0, ...sums(r) })),
    byDay: raw.byDay.map((r) => ({ day: String(r.day), ...sums(r) })),
    bySession: raw.bySession.map((r) => ({ sessionId: String(r.sessionId), last: num(r.last), ...sums(r), workspaceId: String(r.workspaceId), title: text(r.title) || null })),
    routed: {
      totals: rsums(raw.routedTotals),
      byBackend: raw.routedByBackend.map((r) => ({ alias: String(r.alias), providerId: String(r.providerId), modelId: String(r.modelId), tier: String(r.tier), ...rsums(r) })),
    },
  }
}

export async function cloudUsage(userId: string, days: number, workspaceId?: string | null): Promise<CloudUsage> {
  const since = Date.now() - days * 86_400_000
  const m = pgSchema.messages
  const s = pgSchema.chatSessions
  const r = pgSchema.routerEvents
  const tokens = sql`${m.inputTokens}+${m.outputTokens}+${m.reasoningTokens}`

  const msums = {
    messages: sql<number>`count(*)::int`,
    input: sql<number>`coalesce(sum(${m.inputTokens}),0)::float8`,
    output: sql<number>`coalesce(sum(${m.outputTokens}),0)::float8`,
    reasoning: sql<number>`coalesce(sum(${m.reasoningTokens}),0)::float8`,
    cacheRead: sql<number>`coalesce(sum(${m.cacheReadTokens}),0)::float8`,
    cacheWrite: sql<number>`coalesce(sum(${m.cacheWriteTokens}),0)::float8`,
    cost: sql<number>`coalesce(sum(${m.cost}),0)::float8`,
    freeTokens: sql<number>`coalesce(sum(case when ${m.free} then ${tokens} else 0 end),0)::float8`,
    paidTokens: sql<number>`coalesce(sum(case when not ${m.free} then ${tokens} else 0 end),0)::float8`,
  }
  const mconds: SQL[] = [eq(m.userId, userId), eq(m.role, "assistant"), gte(m.createdAt, new Date(since))]
  if (workspaceId) mconds.push(eq(m.workspaceId, workspaceId))
  const mwhere = and(...mconds)

  const rsumsSql = {
    requests: sql<number>`count(*)::int`,
    ok: sql<number>`coalesce(sum(case when ${r.status}='ok' then 1 else 0 end),0)::int`,
    rateLimited: sql<number>`coalesce(sum(case when ${r.status}='rate_limited' then 1 else 0 end),0)::int`,
    errors: sql<number>`coalesce(sum(case when ${r.status}='error' then 1 else 0 end),0)::int`,
    input: sql<number>`coalesce(sum(${r.inputTokens}),0)::float8`,
    output: sql<number>`coalesce(sum(${r.outputTokens}),0)::float8`,
    cost: sql<number>`coalesce(sum(${r.cost}),0)::float8`,
    avgLatency: sql<number>`coalesce(avg(case when ${r.status}='ok' then ${r.latencyMs} end),0)::float8`,
    timeouts: sql<number>`coalesce(sum(case when ${r.status}='timeout' then 1 else 0 end),0)::int`,
    avgTtft: sql<number | null>`(avg(case when ${r.status}='ok' then ${r.ttftMs} end))::float8`,
  }
  const rconds: SQL[] = [eq(r.userId, userId), gte(r.ts, new Date(since))]
  if (workspaceId) rconds.push(eq(r.workspaceId, workspaceId))
  const rwhere = and(...rconds)

  const day = sql<string>`to_char(${m.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`
  const last = sql<number>`round(extract(epoch from max(${m.createdAt}))*1000)::float8`

  const raw = await withUser(userId, async (tx) => {
    const [totals] = await tx.select(msums).from(m).where(mwhere)
    const byModel = await tx
      .select({ providerId: m.providerId, modelId: m.modelId, free: m.free, ...msums })
      .from(m)
      .where(mwhere)
      .groupBy(m.providerId, m.modelId, m.free)
      .orderBy(desc(msums.cost), desc(msums.input))
    const byDay = await tx.select({ day, ...msums }).from(m).where(mwhere).groupBy(day).orderBy(day)
    const bySession = await tx
      .select({ sessionId: m.sessionId, last, ...msums, workspaceId: m.workspaceId, title: sql<string | null>`max(${s.title})` })
      .from(m)
      .leftJoin(s, eq(s.id, m.sessionId))
      .where(mwhere)
      .groupBy(m.sessionId, m.workspaceId)
      .orderBy(desc(sql`max(${m.createdAt})`))
      .limit(50)
    const [routedTotals] = await tx.select(rsumsSql).from(r).where(rwhere)
    const routedByBackend = await tx
      .select({ alias: r.alias, providerId: r.providerId, modelId: r.modelId, tier: r.tier, ...rsumsSql })
      .from(r)
      .where(rwhere)
      .groupBy(r.alias, r.providerId, r.modelId, r.tier)
      .orderBy(desc(rsumsSql.requests))
    return { totals, byModel, byDay, bySession, routedTotals, routedByBackend }
  })

  return shapeUsage(days, since, raw as Parameters<typeof shapeUsage>[2])
}
