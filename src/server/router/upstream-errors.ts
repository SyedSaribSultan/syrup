/**
 * Upstream failure classification: pure functions, no I/O, unit-tested by
 * scripts/test-router.mjs. Given what came back from a provider, decide why it
 * failed, what to cool down (one backend, or the whole key) and until when.
 */

export type FailReason =
  | "rpd"
  | "rpm"
  | "tpm"
  | "context"
  | "bad_request"
  | "auth"
  | "error"
  | "overloaded"
  | "network"
  | "timeout"
  | "empty"
  /** syrup's own cloud relay failed (database, token, platform): says nothing about the provider, cools nothing. */
  | "relay"

/** backend = provider/model/key; key = every model on provider+key; keyFree = every $0 model on provider+key. */
export type CoolScope = "backend" | "key" | "keyFree" | "none"

export type Classified = {
  reason: FailReason
  /** RouterEvent.status. */
  status: "rate_limited" | "error" | "timeout"
  scope: CoolScope
  /** Epoch ms the cooldown ends, or null. */
  retryAt: number | null
  /** Counts against the backend's error EWMA (its own fault, not the request's or a quota). */
  unhealthy: boolean
  /** Readable one-liner for logs and the aggregated error. Never contains request content. */
  message: string
  /** Learned: largest prompt this backend is likely to accept. */
  learnedMaxPrompt?: number
  /** Learned: tokens-per-minute limit. */
  learnedTpm?: number
  /** Learned: this model rejects a thinking/reasoning-effort parameter; send it plain from now on. */
  learnedNoReasoningParam?: boolean
}

export type UpstreamFailure = {
  status: number
  headers: Record<string, string>
  body: string
  providerID: string
  promptTokens: number
  now: number
  /** Consecutive overloads already seen on this backend (for the doubling cooldown). */
  overloads?: number
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// ------------------------------------------------------------------ time helpers

/** Parses retry-after (seconds or HTTP date) into ms from now. */
export function parseRetryAfter(v: string | undefined, now: number): number | null {
  if (!v) return null
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const d = Date.parse(v)
  return Number.isFinite(d) ? Math.max(0, d - now) : null
}

/** Groq / OpenAI style durations: "1.2s", "120ms", "2m59.56s", "1h2m3s", or a bare number of seconds. */
export function parseDuration(v: string | undefined): number | null {
  if (!v) return null
  const t = v.trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 1000
  let ms = 0
  let matched = false
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    matched = true
    const n = Number(m[1])
    ms += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * MIN : n * HOUR
  }
  return matched ? ms : null
}

/** Rate-limit reset header → epoch ms. Accepts durations, epoch seconds and epoch ms (OpenRouter). */
export function parseReset(v: string | undefined, now: number): number | null {
  if (!v) return null
  const n = Number(v)
  if (Number.isFinite(n)) {
    if (n > 1e12) return n
    if (n > 1e9) return n * 1000
    return now + n * 1000
  }
  const d = parseDuration(v)
  return d === null ? null : now + d
}

/** Offset of a time zone from UTC at `at`, in ms (positive east of UTC). */
function tzOffset(at: number, timeZone: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(at))) if (part.type !== "literal") p[part.type] = Number(part.value)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
  return asUtc - Math.floor(at / 1000) * 1000
}

/** Next local midnight in `timeZone` after `now`, as epoch ms. DST-safe. */
export function nextMidnight(now: number, timeZone: string): number {
  const off = tzOffset(now, timeZone)
  const local = new Date(now + off)
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1)
  // The offset at midnight can differ from now's (DST switch); correct with the offset at the guess.
  let t = midnightLocal - off
  const off2 = tzOffset(t, timeZone)
  if (off2 !== off) t = midnightLocal - off2
  return t
}

/** Google's free-tier daily quotas reset at midnight Pacific. */
export function nextPacificMidnight(now: number): number {
  return nextMidnight(now, "America/Los_Angeles")
}

export function nextUtcMidnight(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

// ------------------------------------------------------------------ body parsing

type GoogleDetail = { "@type"?: string; violations?: { quotaId?: string; quotaMetric?: string }[]; retryDelay?: string; reason?: string }
type ErrorObj = { message?: string; code?: number | string; status?: string; type?: string; details?: GoogleDetail[]; metadata?: { raw?: string } }

/** The provider's error object, whichever wrapper it came in ({error}, [{error}], or bare). */
export function errorObject(body: string): ErrorObj | null {
  let j: unknown
  try {
    j = JSON.parse(body)
  } catch {
    return null
  }
  if (Array.isArray(j)) j = j[0]
  if (!j || typeof j !== "object") return null
  const o = j as { error?: unknown }
  if (o.error && typeof o.error === "object") return o.error as ErrorObj
  if (typeof o.error === "string") return { message: o.error }
  return j as ErrorObj
}

function messageOf(body: string, err: ErrorObj | null): string {
  const raw = err?.metadata?.raw
  const m = [err?.message, typeof raw === "string" ? raw : undefined].filter(Boolean).join(" ")
  return (m || body).replace(/\s+/g, " ").trim()
}

function short(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** Only wording that means the prompt does not fit the context window: a false match teaches the router a wrong prompt cap. */
const CONTEXT_RE = /context[ _-](?:length|window)|maximum context|prompt is too long|prompt exceeds|input token count.*exceeds|too many (?:input )?tokens|reduce the length of the (?:messages|prompt|input)|input is too long|tokens \+ `?max_new_tokens|exceeds? (?:the )?context limit/i
/** A rejected or expired key reported as a 400 (Google's OpenAI-compatible endpoint does this) instead of 401/403. */
const KEY_REJECTED_RE = /API[_ ]?key (?:not valid|invalid|expired)|pass a valid API key|API_KEY_INVALID|invalid api[_ ]?key|incorrect api key/i
const TPM_RE = /tokens per minute|\bTPM\b/i
const OVERLOADED_RE = /overloaded|high demand|UNAVAILABLE|capacity|try again later/i
/** A 403 that is about the key or account, not about one model (OpenRouter answers 403 for "this model is only available on …"). */
const KEY_FORBIDDEN_RE = /unauthori[sz]ed|not authori[sz]ed|permission denied|forbidden for this (?:key|account)|account (?:is )?(?:disabled|suspended|blocked)|(?:key|account) (?:has been|is) (?:disabled|revoked|suspended)|insufficient permissions|verify your (?:account|organization)|no access to/i
/** A model that refuses the thinking/reasoning-effort parameter outright (Google's Gemma models through the OpenAI-compatible endpoint). */
const NO_REASONING_RE = /thinking(?: level| budget| config)? is not supported|does not support (?:thinking|reasoning)|reasoning(?:_effort)? (?:is )?not supported|unknown (?:parameter|field)[^.]*reasoning/i

/** Google's violated quota ids (" (GenerateRequestsPerMinutePerProjectPerModel-FreeTier)"), deduplicated and capped; "" when there are none. */
function quotaNames(details: GoogleDetail[]): string {
  const ids = new Set<string>()
  for (const d of details) {
    if (!String(d["@type"] ?? "").includes("QuotaFailure")) continue
    for (const v of d.violations ?? []) {
      const id = typeof v.quotaId === "string" ? v.quotaId.replace(/[^\w.:-]/g, "").slice(0, 80) : ""
      if (id) ids.add(id)
    }
  }
  return ids.size ? ` (${short([...ids].slice(0, 3).join(", "), 200)})` : ""
}

function fmtUntil(retryAt: number, now: number): string {
  const s = Math.round((retryAt - now) / 1000)
  if (s < 120) return `${s}s`
  if (s < 2 * 3600) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}

// ------------------------------------------------------------------ classification

/**
 * Header the cloud LLM relay (src/app/api/ingest/llm/relay.ts) and the sidecar's
 * relay fetch (sidecar/relay-fetch.ts) put on every answer the provider did not
 * write. Its value says what failed; everything else on that hop is the
 * provider's own answer, classified as if it came direct.
 */
export const RELAY_ERROR_HEADER = "x-syrup-relay-error"

export type RelayErrorKind =
  /** The sandbox's ingest token is missing, forged, expired, or its session ended. */
  | "token"
  /** The app could not read the key or the model catalog (database or network blip on the app side). */
  | "unavailable"
  /** The platform (Vercel) answered instead of the relay: a crash, a limit, a timeout of the app itself. */
  | "platform"
  /** The user has no active key for this provider in syrup. */
  | "no_key"
  /** The relay refused this model or these parameters for this key (spend policy). */
  | "policy"
  /** The request cannot pass the relay at all (body too large even without old images, bad shape). */
  | "too_large"
  | "bad_request"
  /** The request is over the relay's size cap because of its text: a real context overflow, so OpenCode compacts. */
  | "overflow"
  /** The relay could not reach the provider, or the provider sent no headers before the relay's time limit. */
  | "upstream"
  | "deadline"

function classifyRelay(kind: string, status: number, msg: string, promptTokens: number, now: number): Classified {
  const m = short(msg, 120)
  switch (kind) {
    case "no_key":
      // The key was removed in Settings: like a rejected key, every model on it is off until the metadata catches up.
      return { reason: "auth", status: "error", scope: "key", retryAt: now + 10 * MIN, unhealthy: false, message: `key rejected (${status}): ${m}` }
    case "policy":
      // This backend cannot be used through the relay with this key; another may. Not the backend's health.
      return { reason: "error", status: "error", scope: "backend", retryAt: now + HOUR, unhealthy: false, message: `refused by syrup's relay (${status}): ${m}` }
    case "overflow":
      return { reason: "context", status: "error", scope: "none", retryAt: null, unhealthy: false, learnedMaxPrompt: Math.floor(promptTokens * 0.95), message: `prompt (~${promptTokens} tokens) too long for syrup's cloud relay` }
    case "too_large":
    case "bad_request":
      return { reason: "bad_request", status: "error", scope: "none", retryAt: null, unhealthy: false, message: `rejected by syrup's relay (${status}): ${m}` }
    case "upstream":
    case "deadline":
      return classifyNetwork(`via syrup's relay: ${m}`, now)
    default:
      // token, unavailable, platform, and anything newer than this router: the app failed, not the provider.
      return { reason: "relay", status: "error", scope: "none", retryAt: null, unhealthy: false, message: `syrup relay failed (${status}): ${m}` }
  }
}

/** Why a non-2xx (or an error event inside a 200 stream) happened and what to cool. */
export function classifyFailure(f: UpstreamFailure): Classified {
  const { status, headers, body, providerID, promptTokens, now } = f
  const err = errorObject(body)
  const msg = messageOf(body, err)

  const relayKind = headers[RELAY_ERROR_HEADER]
  if (relayKind) return classifyRelay(relayKind, status, msg, promptTokens, now)

  if (status === 429) {
    // Google: per-model quotas, typed in error.details.
    const details = Array.isArray(err?.details) ? err.details : []
    const quotaIds = details.flatMap((d) => (String(d["@type"] ?? "").includes("QuotaFailure") ? (d.violations ?? []).map((v) => `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`) : []))
    const retryInfo = details.find((d) => String(d["@type"] ?? "").includes("RetryInfo"))
    // The quota ids themselves go into the message: a requests-per-minute and an input-tokens-per-minute limit both
    // read as "rpm", and only the id tells them apart when a failover is investigated (docs/QUALITY.md Q5).
    const which = quotaNames(details)
    if (quotaIds.some((q) => /PerDay/i.test(q))) {
      const retryAt = nextPacificMidnight(now)
      return { reason: "rpd", status: "rate_limited", scope: "backend", retryAt, unhealthy: false, message: `daily free quota used up${which} (resets at midnight Pacific, in ${fmtUntil(retryAt, now)})` }
    }
    if (quotaIds.some((q) => /PerMinute/i.test(q)) || retryInfo) {
      const delay = parseDuration(retryInfo?.retryDelay) ?? parseRetryAfter(headers["retry-after"], now) ?? MIN
      const retryAt = now + Math.min(Math.max(delay, 1000), 15 * MIN)
      return { reason: "rpm", status: "rate_limited", scope: "backend", retryAt, unhealthy: false, message: `per-minute quota hit${which} (retry in ${fmtUntil(retryAt, now)})` }
    }
    // OpenRouter: the free-model daily cap is shared by every free model on the account.
    if (providerID === "openrouter" && /per-day|free-models-per-day|per day/i.test(msg)) {
      const retryAt = nextUtcMidnight(now)
      return { reason: "rpd", status: "rate_limited", scope: "keyFree", retryAt, unhealthy: false, message: `free-model daily cap reached for this OpenRouter account (resets at 00:00 UTC, in ${fmtUntil(retryAt, now)})` }
    }
    // Groq / Cerebras token budgets.
    if ((providerID === "groq" || providerID === "cerebras") && TPM_RE.test(msg)) {
      const limit = Number(headers["x-ratelimit-limit-tokens"]) || Number(/limit[:\s]+(\d+)/i.exec(msg)?.[1]) || undefined
      const requested = Number(/requested[:\s]+(\d+)/i.exec(msg)?.[1]) || promptTokens
      if (limit && requested > limit) {
        return { reason: "tpm", status: "rate_limited", scope: "none", retryAt: null, unhealthy: false, learnedTpm: limit, message: `request (~${requested} tokens) exceeds the ${limit} tokens-per-minute limit` }
      }
      const retryAt = now + MIN
      return { reason: "rpm", status: "rate_limited", scope: "backend", retryAt, unhealthy: false, learnedTpm: limit, message: `tokens-per-minute budget used up (retry in 60s)` }
    }
    const daily = /\bday\b|daily|per.?day/i.test(msg)
    if (daily) {
      const retryAt = Math.min(nextUtcMidnight(now), now + DAY)
      return { reason: "rpd", status: "rate_limited", scope: "backend", retryAt, unhealthy: false, message: `daily limit reached (retry in ${fmtUntil(retryAt, now)})` }
    }
    const wait = parseRetryAfter(headers["retry-after"], now) ?? MIN
    const retryAt = now + Math.min(Math.max(wait, 1000), 15 * MIN)
    return { reason: "rpm", status: "rate_limited", scope: "backend", retryAt, unhealthy: false, message: `rate limited (retry in ${fmtUntil(retryAt, now)})` }
  }

  if ((status === 413 || status === 400) && (providerID === "groq" || providerID === "cerebras") && TPM_RE.test(msg)) {
    const limit = Number(headers["x-ratelimit-limit-tokens"]) || Number(/limit[:\s]+(\d+)/i.exec(msg)?.[1]) || undefined
    return { reason: "tpm", status: "rate_limited", scope: "none", retryAt: null, unhealthy: false, learnedTpm: limit, message: `request too large for the tokens-per-minute limit${limit ? ` (${limit})` : ""}` }
  }

  const keyRejected = KEY_REJECTED_RE.test(msg) || (Array.isArray(err?.details) && err.details.some((d) => d?.reason === "API_KEY_INVALID"))
  // 401, or a 400/403 whose words blame the key or account: every model on this key is off for a while. A 403 that
  // says nothing about the key (a model gated to another plan, a blocked model) is this one model refusing us,
  // below, so one such model never benches the whole provider.
  if (status === 401 || ((status === 400 || status === 403) && keyRejected) || (status === 403 && KEY_FORBIDDEN_RE.test(msg) && !/flagged|moderation/i.test(msg))) {
    const retryAt = now + 10 * MIN
    return { reason: "auth", status: "error", scope: "key", retryAt, unhealthy: false, message: `key rejected (${status}): ${short(msg, 100)}` }
  }
  if (status === 403 && !/flagged|moderation/i.test(msg)) {
    const retryAt = now + HOUR
    return { reason: "error", status: "error", scope: "backend", retryAt, unhealthy: false, message: `model refused this key (403): ${short(msg, 100)}` }
  }

  if (status === 400 && NO_REASONING_RE.test(msg)) {
    return { reason: "bad_request", status: "error", scope: "none", retryAt: null, unhealthy: false, learnedNoReasoningParam: true, message: `rejects the thinking parameter (400): ${short(msg, 100)}` }
  }

  if (status === 413 || (status === 400 && (CONTEXT_RE.test(msg) || /context_length_exceeded/i.test(String(err?.code ?? ""))))) {
    return {
      reason: "context",
      status: "error",
      scope: "none",
      retryAt: null,
      unhealthy: false,
      learnedMaxPrompt: Math.floor(promptTokens * 0.95),
      message: `prompt (~${promptTokens} tokens) too long for this model`,
    }
  }

  if (status === 402) {
    const retryAt = now + 30 * MIN
    return { reason: "error", status: "error", scope: "key", retryAt, unhealthy: false, message: `payment required (402): ${short(msg, 100)}` }
  }

  if (status === 404) {
    // The catalog lists a model the provider has retired ("no longer available"). It will not come back within the
    // hour, and trying it costs a full attempt on every request, so it is out for the day. Not the model's health.
    const retryAt = now + DAY
    return { reason: "error", status: "error", scope: "backend", retryAt, unhealthy: false, message: `model not found (404): ${short(msg, 100)}` }
  }

  if (status >= 500 || status === 408 || status === 409 || OVERLOADED_RE.test(msg) || /UNAVAILABLE/.test(String(err?.status ?? ""))) {
    const n = Math.max(0, f.overloads ?? 0)
    const retryAt = now + Math.min(30_000 * 2 ** n, 5 * MIN)
    return { reason: "overloaded", status: "error", scope: "backend", retryAt, unhealthy: true, message: `overloaded (${status}): ${short(msg, 100)}` }
  }

  if (status === 400 || status === 422 || status === 403) {
    return { reason: "bad_request", status: "error", scope: "none", retryAt: null, unhealthy: false, message: `rejected the request (${status}): ${short(msg, 160)}` }
  }

  const retryAt = now + 30_000
  return { reason: "error", status: "error", scope: "backend", retryAt, unhealthy: true, message: `failed (${status}): ${short(msg, 100)}` }
}

export function classifyNetwork(message: string, now: number): Classified {
  return { reason: "network", status: "error", scope: "backend", retryAt: now + 15_000, unhealthy: true, message: `network error: ${short(message, 100)}` }
}

export function classifyTimeout(deadlineMs: number, now: number): Classified {
  return { reason: "timeout", status: "timeout", scope: "backend", retryAt: now + 45_000, unhealthy: true, message: `no first token within ${Math.round(deadlineMs / 1000)}s` }
}

export function classifyEmpty(now: number, message = "stream ended without any content"): Classified {
  return { reason: "empty", status: "error", scope: "backend", retryAt: now + 30_000, unhealthy: true, message }
}

// ------------------------------------------------------------------ success headers

export type HeaderLearning = {
  remainingRequests?: number
  remainingTokens?: number
  limitTokens?: number
  resetRequestsAt?: number
  resetTokensAt?: number
}

/** x-ratelimit-* on a successful response. */
export function learnFromHeaders(h: Record<string, string>, now: number): HeaderLearning {
  const num = (k: string) => {
    const v = h[k]
    if (v === undefined || v === "") return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const out: HeaderLearning = {}
  const rr = num("x-ratelimit-remaining-requests") ?? num("x-ratelimit-remaining")
  if (rr !== undefined) out.remainingRequests = rr
  const rt = num("x-ratelimit-remaining-tokens")
  if (rt !== undefined) out.remainingTokens = rt
  const lt = num("x-ratelimit-limit-tokens")
  if (lt !== undefined) out.limitTokens = lt
  const resetReq = parseReset(h["x-ratelimit-reset-requests"] ?? h["x-ratelimit-reset"], now)
  if (resetReq !== null) out.resetRequestsAt = resetReq
  const resetTok = parseReset(h["x-ratelimit-reset-tokens"], now)
  if (resetTok !== null) out.resetTokensAt = resetTok
  return out
}
