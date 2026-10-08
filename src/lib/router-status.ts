/**
 * Shapes of the router status API (GET /api/router/status and
 * GET /api/router/answers). Both modes derive them from router_events, so the
 * UI reads the same thing locally and in the cloud.
 */

export type CoolReason = "rpd" | "rpm" | "overloaded" | "auth" | "timeout" | "error"

export type BackendState = {
  providerId: string
  modelId: string
  /** Epoch ms while the router is skipping this backend (its own cooldown or its key's), else null. */
  coolingUntil: number | null
  coolReason: CoolReason | null
  /** Median time to first token over recent successful requests, ms. */
  ttftMs: number | null
  /** Share of recent attempts that succeeded, 0–1. Null without data. */
  okRate: number | null
  /** Epoch ms of the most recent attempt. */
  lastUsed: number | null
}

export type AliasPick = { providerId: string; modelId: string; at: number } | null

/** A cooldown on a provider's active key: every model on it, or only its free models (OpenRouter's account-wide daily cap). */
export type KeyCooldown = { providerId: string; freeOnly: boolean; until: number; reason: CoolReason }

export type RouterStatus = {
  /** Server time the snapshot was taken, epoch ms. */
  at: number
  backends: BackendState[]
  /** Backend each alias most recently answered with. */
  aliases: { auto: AliasPick; fast: AliasPick }
  /** Provider ids whose active key was rejected in the last hour and not accepted since. */
  authFailures: string[]
  /** Key-wide cooldowns, which also cover models with no recent row in `backends`. Read through `coolingFor`. */
  keyCooldowns?: KeyCooldown[]
}

/** One routed request inside a chat session whose content reached the chat. */
export type Answer = {
  /** When the router recorded it, at the end of the request. */
  ts: number
  alias: string
  providerId: string
  modelId: string
  ttftMs: number | null
  /** From the router receiving the request to `ts`, so `ts - latencyMs` is when it started. */
  latencyMs: number
  attempts: number
  reason: string | null
  /** Prompt tokens the backend reported; 0 when the stream ended before usage arrived. */
  inputTokens?: number
  /** The stream broke or was stopped after content had reached the chat. */
  partial?: boolean
}

/** One router attempt in a chat, success or not: what the "waiting" line shows while the first token is still to come. */
export type Attempt = {
  ts: number
  alias: string
  providerId: string
  modelId: string
  /** "ok" | "rate_limited" | "error" | "timeout" | "aborted" */
  status: string
  reason: string | null
  /** The router's one-line reason for a failure, or null. */
  error: string | null
}

/**
 * Attempts the router cut on purpose, which say nothing went wrong: a second model that raced the first one and lost
 * ("hedged"), and an optional chat-title call it let go ("title_skipped"; title rows also carry no session id).
 */
const NOT_DROPPED = new Set(["hedged", "title_skipped"])

/** Whether the "waiting" line should report this attempt as a model the router dropped. */
export function droppedAttempt(a: Pick<Attempt, "status" | "reason">): boolean {
  return a.status !== "ok" && !NOT_DROPPED.has(a.reason ?? "")
}

/** Why a model was dropped, in a few plain words. */
const DROP_WHY: Record<string, string> = {
  overloaded: "is overloaded",
  timeout: "didn't answer in time",
  rpm: "hit its rate limit",
  rpd: "used up its daily quota",
  tpm: "can't take a request this size",
  auth: "rejected the key",
  bad_request: "rejected the request",
  context: "can't fit this conversation",
  network: "couldn't be reached",
  empty: "answered with nothing",
  error: "failed",
}

/**
 * The "waiting" line (router-progress.tsx): which model the router dropped last and why, or null when none was.
 * React-free so it can be tested; `label` names a model id.
 */
export function describeDrops(attempts: readonly Attempt[], label: (modelId: string) => string): string | null {
  // A lost hedge race or a skipped chat title is not a dropped model: nothing went wrong.
  const failed = attempts.filter(droppedAttempt)
  if (failed.length === 0) return null
  const last = failed[failed.length - 1]
  const why = DROP_WHY[last.reason ?? ""] ?? "failed"
  const name = label(last.modelId)
  if (failed.length === 1) return `${name} ${why}. Trying another model…`
  return `${name} ${why}, ${failed.length - 1} other${failed.length === 2 ? "" : "s"} before it. Trying another model…`
}

export type AnswersResponse = {
  answers: Answer[]
  /** Only with `?live=1`: every attempt of the last few minutes, oldest first, failures included. */
  attempts?: Attempt[]
}

export function backendKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** OpenRouter's $0 variants, which share the account-wide free daily cap. */
export function isFreeVariant(modelId: string): boolean {
  return modelId.endsWith(":free")
}

/** When and why the router skips a model, from its own cooldown or its key's; null when usable. */
export function coolingFor(status: RouterStatus, providerId: string, modelId: string): { until: number; reason: CoolReason } | null {
  let best: { until: number; reason: CoolReason } | null = null
  const b = status.backends.find((x) => x.providerId === providerId && x.modelId === modelId)
  if (b?.coolingUntil && b.coolingUntil > status.at) best = { until: b.coolingUntil, reason: b.coolReason ?? "error" }
  for (const k of status.keyCooldowns ?? []) {
    if (k.providerId !== providerId || k.until <= status.at || (k.freeOnly && !isFreeVariant(modelId))) continue
    if (!best || k.until > best.until) best = { until: k.until, reason: k.reason }
  }
  return best
}
