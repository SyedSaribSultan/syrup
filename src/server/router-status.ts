import { and, desc, eq, gte, isNotNull, or } from "drizzle-orm"
import { backendKey, isFreeVariant, type Answer, type AliasPick, type Attempt, type BackendState, type CoolReason, type KeyCooldown, type RouterStatus } from "@/lib/router-status"
import { db, dbReady, schema } from "./db"
import { pgSchema, withUser } from "./db/pg"
import { keysDb } from "./key-rows"
import { BASE_URL, ENV_NAMES } from "./router/backends"

/**
 * Router status and per-session answers, derived from router_events.
 * Local mode reads SQLite; cloud mode reads Postgres scoped to one user.
 * Both feed the same pure builder, so the UI sees identical shapes.
 */

/** The router_events columns the status snapshot needs, with times as epoch ms. */
export type StatusRow = {
  ts: number
  alias: string
  providerId: string
  modelId: string
  /** Vault key id, null for an env key. */
  keyId: string | null
  status: string
  httpStatus: number | null
  ttftMs: number | null
  retryAt: number | null
  reason: string | null
  /** The router's message for the attempt; tells OpenRouter's account-wide daily cap apart from a single model's. */
  error?: string | null
}

/**
 * The key the router uses now for each provider: a vault key id, or null for an env key.
 * A provider missing from the map has no key the router uses.
 */
export type ActiveKeys = ReadonlyMap<string, string | null>

const WINDOW_MS = 24 * 3_600_000
const MAX_ROWS = 3000
const RECENT = 20
const AUTH_WINDOW_MS = 3_600_000
const MAX_ANSWERS = 500

/**
 * Statuses that count as an attempt for okRate. "aborted" is an attempt cut short by the client hanging up or by the
 * router itself (a lost hedge race, a chat title it let go), not the backend's fault.
 */
const ATTEMPT_STATUSES = new Set(["ok", "rate_limited", "error", "timeout"])
const COOL_REASONS = new Set<CoolReason>(["rpd", "rpm", "overloaded", "auth", "timeout"])

function coolReasonOf(r: StatusRow): CoolReason {
  if (r.reason && COOL_REASONS.has(r.reason as CoolReason)) return r.reason as CoolReason
  // Rows written before the reason column existed.
  if (!r.reason) {
    if (r.status === "timeout") return "timeout"
    if (r.status === "rate_limited") return "rpm"
    if (r.httpStatus === 401 || r.httpStatus === 403) return "auth"
  }
  return "error"
}

function isAuthFailure(r: StatusRow): boolean {
  return r.reason === "auth" || (r.reason == null && (r.httpStatus === 401 || r.httpStatus === 403))
}

/** What the router cooled for this row (health.applyCooldown): one backend, the whole key, or every free model on the key. */
function coolScope(r: StatusRow): "backend" | "key" | "keyFree" {
  if (isAuthFailure(r) || r.httpStatus === 402) return "key"
  if (r.providerId === "openrouter" && r.httpStatus === 429 && isFreeVariant(r.modelId) && /free-model daily cap/i.test(r.error ?? "")) return "keyFree"
  return "backend"
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

function aliasName(alias: string): string {
  return alias.startsWith("syrup/") ? alias.slice("syrup/".length) : alias
}

type Acc = {
  providerId: string
  modelId: string
  newest: StatusRow
  okTtfts: number[]
  okCount: number
  attempts: number
  attemptsOk: number
}

type Cool = { until: number; reason: CoolReason }

/**
 * Turns router_events rows (any order) into a status snapshot. Pure; `now` is injectable for tests.
 * With `keys`, cooldowns and rejected-key warnings count only for the key each provider uses now: the router cools per key.
 */
export function buildRouterStatus(rows: StatusRow[], now = Date.now(), keys?: ActiveKeys): RouterStatus {
  const current = (r: StatusRow) => !keys || (keys.has(r.providerId) && keys.get(r.providerId) === r.keyId)
  const sorted = [...rows].sort((a, b) => b.ts - a.ts)
  const byBackend = new Map<string, Acc>()
  const aliases: { auto: AliasPick; fast: AliasPick } = { auto: null, fast: null }
  const newestOkByProvider = new Map<string, number>()
  const newestAuthByProvider = new Map<string, StatusRow>()
  const backendCool = new Map<string, Cool>()
  const keyCool = new Map<string, KeyCooldown>()

  for (const r of sorted) {
    const key = backendKey(r.providerId, r.modelId)
    let a = byBackend.get(key)
    if (!a) {
      a = { providerId: r.providerId, modelId: r.modelId, newest: r, okTtfts: [], okCount: 0, attempts: 0, attemptsOk: 0 }
      byBackend.set(key, a)
    }
    if (r.status === "ok") {
      if (a.okCount < RECENT) {
        a.okCount++
        if (r.ttftMs != null) a.okTtfts.push(r.ttftMs)
      }
      if (!newestOkByProvider.has(r.providerId)) newestOkByProvider.set(r.providerId, r.ts)
      const name = aliasName(r.alias)
      if ((name === "auto" || name === "fast") && !aliases[name]) aliases[name] = { providerId: r.providerId, modelId: r.modelId, at: r.ts }
    }
    if (ATTEMPT_STATUSES.has(r.status) && a.attempts < RECENT) {
      a.attempts++
      if (r.status === "ok") a.attemptsOk++
    }
    if (isAuthFailure(r) && !newestAuthByProvider.has(r.providerId)) newestAuthByProvider.set(r.providerId, r)
    // A later success does not lift a cooldown in the router, so any row still in the future counts, not just the newest.
    if (r.retryAt != null && r.retryAt > now && current(r)) {
      const scope = coolScope(r)
      const reason = coolReasonOf(r)
      if (scope === "backend") {
        const prev = backendCool.get(key)
        if (!prev || r.retryAt > prev.until) backendCool.set(key, { until: r.retryAt, reason })
      } else {
        const id = `${r.providerId}\u0000${scope}`
        const prev = keyCool.get(id)
        if (!prev || r.retryAt > prev.until) keyCool.set(id, { providerId: r.providerId, freeOnly: scope === "keyFree", until: r.retryAt, reason })
      }
    }
  }

  const keyCooldowns = [...keyCool.values()]
  const backends: BackendState[] = [...byBackend.values()].map((a) => {
    let cool = backendCool.get(backendKey(a.providerId, a.modelId)) ?? null
    for (const k of keyCooldowns) {
      if (k.providerId !== a.providerId || (k.freeOnly && !isFreeVariant(a.modelId))) continue
      if (!cool || k.until > cool.until) cool = { until: k.until, reason: k.reason }
    }
    return {
      providerId: a.providerId,
      modelId: a.modelId,
      coolingUntil: cool?.until ?? null,
      coolReason: cool?.reason ?? null,
      ttftMs: median(a.okTtfts),
      okRate: a.attempts > 0 ? a.attemptsOk / a.attempts : null,
      lastUsed: a.newest.ts,
    }
  })

  const authFailures: string[] = []
  for (const [providerId, r] of newestAuthByProvider) {
    if (now - r.ts > AUTH_WINDOW_MS || !current(r)) continue
    const ok = newestOkByProvider.get(providerId)
    if (ok == null || r.ts > ok) authFailures.push(providerId)
  }

  return { at: now, backends, aliases, authFailures: authFailures.sort(), keyCooldowns }
}

type AnswerRow = {
  ts: number
  alias: string
  providerId: string
  modelId: string
  status: string
  ttftMs: number | null
  latencyMs: number
  attempts: number
  inputTokens: number
  reason: string | null
}

/** Newest N rows (any order in), returned oldest first. A stream that broke or was stopped after its first token still answered. */
export function toAnswers(rows: AnswerRow[]): Answer[] {
  return [...rows]
    .sort((a, b) => a.ts - b.ts)
    .map((x) => ({
      ts: x.ts,
      alias: aliasName(x.alias),
      providerId: x.providerId,
      modelId: x.modelId,
      ttftMs: x.ttftMs,
      latencyMs: x.latencyMs,
      attempts: x.attempts,
      reason: x.reason,
      inputTokens: x.inputTokens,
      partial: x.status !== "ok",
    }))
}

/** How far back the live "waiting" line looks for attempts of a chat. */
const LIVE_WINDOW_MS = 3 * 60_000
const MAX_ATTEMPTS = 40

type AttemptRow = { ts: number; alias: string; providerId: string; modelId: string; status: string; reason: string | null; error: string | null }

function toAttempts(rows: AttemptRow[]): Attempt[] {
  return [...rows].sort((a, b) => a.ts - b.ts).map((x) => ({ ts: x.ts, alias: aliasName(x.alias), providerId: x.providerId, modelId: x.modelId, status: x.status, reason: x.reason, error: x.error }))
}

// ---------------------------------------------------------------- local (SQLite)

/** Mirrors LocalRouterStore.activeKeys without decrypting anything: the active vault key, else an env key. */
async function localActiveKeys(): Promise<ActiveKeys> {
  const k = schema.providerKeys
  const rows = await (await keysDb()).select({ providerId: k.providerId, id: k.id }).from(k).where(eq(k.active, 1))
  const out = new Map<string, string | null>()
  for (const r of rows) if (BASE_URL[r.providerId]) out.set(r.providerId, r.id)
  for (const providerId of Object.keys(BASE_URL)) {
    if (!out.has(providerId) && (ENV_NAMES[providerId] ?? []).some((name) => process.env[name])) out.set(providerId, null)
  }
  return out
}

export async function localRouterStatus(): Promise<RouterStatus> {
  await dbReady()
  const r = schema.routerEvents
  const now = Date.now()
  const [rows, keys] = await Promise.all([
    db()
      .select({ ts: r.ts, alias: r.alias, providerId: r.providerId, modelId: r.modelId, keyId: r.keyId, status: r.status, httpStatus: r.httpStatus, ttftMs: r.ttftMs, retryAt: r.retryAt, reason: r.reason, error: r.error })
      .from(r)
      .where(gte(r.ts, now - WINDOW_MS))
      .orderBy(desc(r.ts))
      .limit(MAX_ROWS),
    localActiveKeys(),
  ])
  return buildRouterStatus(rows, now, keys)
}

export async function localSessionAnswers(sessionId: string): Promise<Answer[]> {
  await dbReady()
  const r = schema.routerEvents
  const rows = await db()
    .select({ ts: r.ts, alias: r.alias, providerId: r.providerId, modelId: r.modelId, status: r.status, ttftMs: r.ttftMs, latencyMs: r.latencyMs, attempts: r.attempts, inputTokens: r.inputTokens, reason: r.reason })
    .from(r)
    .where(and(eq(r.sessionId, sessionId), or(eq(r.status, "ok"), isNotNull(r.ttftMs))))
    .orderBy(desc(r.ts))
    .limit(MAX_ANSWERS)
  return toAnswers(rows)
}

export async function localSessionAttempts(sessionId: string): Promise<Attempt[]> {
  await dbReady()
  const r = schema.routerEvents
  const rows = await db()
    .select({ ts: r.ts, alias: r.alias, providerId: r.providerId, modelId: r.modelId, status: r.status, reason: r.reason, error: r.error })
    .from(r)
    .where(and(eq(r.sessionId, sessionId), gte(r.ts, Date.now() - LIVE_WINDOW_MS)))
    .orderBy(desc(r.ts))
    .limit(MAX_ATTEMPTS)
  return toAttempts(rows)
}

// ---------------------------------------------------------------- cloud (Postgres, RLS)

export async function cloudRouterStatus(userId: string): Promise<RouterStatus> {
  const r = pgSchema.routerEvents
  const k = pgSchema.providerKeys
  const now = Date.now()
  const [rows, active] = await withUser(userId, async (tx) => [
    await tx
      .select({ ts: r.ts, alias: r.alias, providerId: r.providerId, modelId: r.modelId, keyId: r.keyId, status: r.status, httpStatus: r.httpStatus, ttftMs: r.ttftMs, retryAt: r.retryAt, reason: r.reason, error: r.error })
      .from(r)
      .where(and(eq(r.userId, userId), gte(r.ts, new Date(now - WINDOW_MS))))
      .orderBy(desc(r.ts))
      .limit(MAX_ROWS),
    // The sandbox router knows only active, enabled keys (keys.activeKeyMeta; the relay adds the secret); cloud has no env keys.
    await tx
      .select({ providerId: k.providerId, id: k.id })
      .from(k)
      .where(and(eq(k.userId, userId), eq(k.active, true), eq(k.enabled, true))),
  ] as const)
  const keys = new Map<string, string | null>()
  for (const x of active) if (BASE_URL[x.providerId]) keys.set(x.providerId, x.id)
  return buildRouterStatus(
    rows.map((x) => ({ ...x, ts: x.ts.getTime(), retryAt: x.retryAt ? x.retryAt.getTime() : null })),
    now,
    keys,
  )
}

export async function cloudSessionAnswers(userId: string, sessionId: string): Promise<Answer[]> {
  const r = pgSchema.routerEvents
  const rows = await withUser(userId, (tx) =>
    tx
      .select({ ts: r.ts, alias: r.alias, providerId: r.providerId, modelId: r.modelId, status: r.status, ttftMs: r.ttftMs, latencyMs: r.latencyMs, attempts: r.attempts, inputTokens: r.inputTokens, reason: r.reason })
      .from(r)
      .where(and(eq(r.userId, userId), eq(r.sessionId, sessionId), or(eq(r.status, "ok"), isNotNull(r.ttftMs))))
      .orderBy(desc(r.ts))
      .limit(MAX_ANSWERS),
  )
  return toAnswers(rows.map((x) => ({ ...x, ts: x.ts.getTime() })))
}

export async function cloudSessionAttempts(userId: string, sessionId: string): Promise<Attempt[]> {
  const r = pgSchema.routerEvents
  const rows = await withUser(userId, (tx) =>
    tx
      .select({ ts: r.ts, alias: r.alias, providerId: r.providerId, modelId: r.modelId, status: r.status, reason: r.reason, error: r.error })
      .from(r)
      .where(and(eq(r.userId, userId), eq(r.sessionId, sessionId), gte(r.ts, new Date(Date.now() - LIVE_WINDOW_MS))))
      .orderBy(desc(r.ts))
      .limit(MAX_ATTEMPTS),
  )
  return toAttempts(rows.map((x) => ({ ...x, ts: x.ts.getTime() })))
}
