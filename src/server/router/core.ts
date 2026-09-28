import crypto from "node:crypto"
import type http from "node:http"
import type { Log } from "../shared/log"
import { ALIASES, BASE_URL, CandidateCache, type Alias, type Candidate } from "./backends"
import { ServedModels } from "./served"
import { displayName, providerName } from "../../lib/model-registry"
import { Health, type Cool } from "./health"
import { applySticky, difficulty, dynamicBlock, estimatePromptTokens, rank, staticFit, type Exclusion, type Msg, type RequestShape, type Scored } from "./policy"
import { InterleavedReasoning, Signatures } from "./reasoning-cache"
import { Sessions, sessionHeader, sessionKey, type SessionState } from "./sessions"
import { chunkKind, SseScanner, StreamTap, type SseLine, type Usage } from "./sse"
import type { RouterEvent, RouterStore } from "./store"
import { classifyEmpty, classifyFailure, classifyNetwork, classifyTimeout, errorObject, learnFromHeaders, type Classified } from "./upstream-errors"

/**
 * syrup router core: an OpenAI-compatible /v1 endpoint the engine talks to as
 * the "syrup" provider. For each request it ranks every backend the user can
 * reach (policy.ts), sends the request to the best one, and fails over to the
 * next before a single byte reaches the client (first-token commit), so a
 * slow, overloaded or rate-limited provider costs a retry, not an error.
 *
 * Pure with respect to storage: keys, catalog and event persistence come from
 * a RouterStore; logging goes through Log. The same code runs in the local
 * server and inside the sandbox sidecar.
 */

export type RouterTiming = {
  /** First-token deadline bounds for an attempt that has a fallback after it. */
  minDeadlineMs: number
  maxDeadlineMs: number
  /** First-token deadline for the last candidate. */
  lastDeadlineMs: number
  /** Wall-clock budget before the first byte reaches the client; no new attempt starts after it. */
  budgetMs: number
  /** After commit: end the response when the upstream is silent this long. */
  idleMs: number
  /** Non-streaming requests: total deadline. */
  nonStreamMs: number
  /** How long the per-(catalog, keys) candidate list is reused. */
  candidateCacheMs: number
}

const DEFAULT_TIMING: RouterTiming = {
  minDeadlineMs: 10_000,
  maxDeadlineMs: 60_000,
  lastDeadlineMs: 120_000,
  budgetMs: 90_000,
  idleMs: 90_000,
  nonStreamMs: 120_000,
  candidateCacheMs: 60_000,
}

const POWERED_BY = /You are powered by the model named (?:auto|fast)\. The exact model ID is syrup\/(?:auto|fast)/

/** Attempts per request that count (failures other than context/TPM rejections), and the hard cap on all attempts. */
const MAX_ATTEMPTS = 4
const MAX_TOTAL_ATTEMPTS = 8

export type RouterOptions = {
  store: RouterStore
  log: Log
  /** Bearer the engine must present. */
  secret: string
  /** Override provider base URLs (tests point providers at local mocks). */
  baseURLs?: Record<string, string>
  /** Clock for cooldowns, TTLs and timestamps. */
  now?: () => number
  timing?: Partial<RouterTiming>
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let ended = false
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      ended = true
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
    req.on("close", () => {
      if (!ended) reject(new Error("client closed the request before sending the body"))
    })
  })
}

function digest(s: string): Buffer {
  return crypto.createHash("sha256").update(s).digest()
}

/**
 * Constant-time bearer check. Compares fixed-size digests: header bytes above
 * 0x7f arrive as latin1 characters, so equal string lengths do not mean equal
 * byte lengths, and timingSafeEqual throws on unequal ones.
 */
export function bearerOk(req: http.IncomingMessage, secret: string): boolean {
  const h = req.headers.authorization ?? ""
  const token = h.startsWith("Bearer ") ? h.slice(7) : ""
  if (!token || !secret) return false
  return crypto.timingSafeEqual(digest(token), digest(secret))
}

const KEPT_HEADERS = [
  "content-type",
  "retry-after",
  "x-request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]

function pickHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of KEPT_HEADERS) {
    const v = h.get(k)
    if (v) out[k] = v
  }
  return out
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
}

function costOf(c: Candidate, u: Usage): number {
  if (!c.costs) return 0
  return ((u.prompt_tokens ?? 0) * c.price.input + (u.completion_tokens ?? 0) * c.price.output) / 1_000_000
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function emptyMessage(tap: StreamTap): string {
  return tap.finishReason ? `finished (${tap.finishReason}) without any content` : "stream ended without any content"
}

function newId(prefix: string, bytes = 8): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`
}

/** res.write that waits for drain (or the client going away) instead of buffering without bound. */
function write(res: http.ServerResponse, chunk: Uint8Array): Promise<void> | undefined {
  if (res.destroyed || res.writableEnded) return
  if (res.write(chunk)) return
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done)
      res.off("close", done)
      resolve()
    }
    res.on("drain", done)
    res.on("close", done)
  })
}

export type Router = {
  /** Handles /v1/* and /health. Returns false if the path is not the router's. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean>
}

/** Everything one chat request carries through its attempts. */
type Ctx = {
  reqID: string
  alias: Alias
  stream: boolean
  body: Record<string, unknown>
  shape: RequestShape
  session: SessionState
  /** The engine's session id (events, logs), null when it sent none. */
  sessionId: string | null
  /** Stickiness / cache key: the session id or a content hash. */
  sessionKey: string
  started: number
  res: http.ServerResponse
  clientGone: () => boolean
  setCurrent: (ac: AbortController | null) => void
}

type Failed = { kind: "failed"; c: Candidate; cls: Classified; httpStatus: number | null; body?: string }
type StreamFail = { reason: "stream_error" | "stream_idle" | "truncated"; message: string }
type AttemptResult = { kind: "done" } | { kind: "aborted" } | Failed

export function createRouter({ store, log, secret, baseURLs, now = Date.now, timing: timingOverride }: RouterOptions): Router {
  const timing: RouterTiming = { ...DEFAULT_TIMING, ...timingOverride }
  const urls = { ...BASE_URL, ...baseURLs }
  const candidates = new CandidateCache(urls, timing.candidateCacheMs, now)
  const served = new ServedModels(now)
  const health = new Health(now)
  const sessions = new Sessions(now)
  const sigs = new Signatures()
  const reasoning = new InterleavedReasoning()

  // Strictly increasing, so an event recorded right after another (a cooldown after the answer that revealed it) sorts as newer.
  let lastTs = 0
  function record(e: Omit<RouterEvent, "id" | "ts">) {
    lastTs = Math.max(now(), lastTs + 1)
    void store.record({ id: newId("rt"), ts: lastTs, ...e, error: e.error ? e.error.slice(0, 500) : null, reason: e.reason ? e.reason.slice(0, 40) : null })
  }

  function models(res: http.ServerResponse) {
    json(res, 200, { object: "list", data: Object.keys(ALIASES).map((id) => ({ id, object: "model", created: 0, owned_by: "syrup" })) })
  }

  function status(res: http.ServerResponse) {
    json(res, 200, { at: now(), ...health.snapshot(), sessions: sessions.size, stuckSessions: sessions.stuck(), reasoningCache: reasoning.size, servedModels: served.snapshot() })
  }

  // ---------------------------------------------------------------- outbound

  /** OpenCode tells the model it is "syrup/auto"; name the backend that actually answers, so "what are you?" gets a true answer. */
  function nameModel(messages: unknown, c: Candidate): unknown {
    if (!Array.isArray(messages)) return messages
    const line = `You are powered by the model named ${displayName(c.model)} (${providerName(c.providerID)}), picked by syrup's router. The exact model ID is ${c.providerID}/${c.modelID}`
    const fix = (t: string) => t.replace(POWERED_BY, line)
    return messages.map((m: Msg) => {
      if (m?.role !== "system") return m
      if (typeof m.content === "string") return POWERED_BY.test(m.content) ? { ...m, content: fix(m.content) } : m
      if (Array.isArray(m.content)) return { ...m, content: m.content.map((p: { type?: string; text?: string }) => (p?.type === "text" && typeof p.text === "string" ? { ...p, text: fix(p.text) } : p)) }
      return m
    })
  }

  /**
   * When an answer is cut off, the engine asks again with the partial answer as the last message. Gemini's
   * thinking models reject that ("Requests ending with a model turn are not supported"), which forced a
   * different model to finish the answer. A short user turn asking to continue keeps it with the same model.
   */
  function continueNudge(messages: unknown): unknown {
    if (!Array.isArray(messages) || messages.length === 0) return messages
    const last = messages[messages.length - 1] as Msg & { tool_calls?: unknown[] }
    if (last?.role !== "assistant" || (Array.isArray(last.tool_calls) && last.tool_calls.length > 0)) return messages
    return [...messages, { role: "user", content: "Continue exactly where your previous message stopped. Don't repeat what you already wrote." }]
  }

  function outboundBody(c: Candidate, s: Scored, ctx: Ctx) {
    const { body } = ctx
    const out: Record<string, unknown> = { ...body, model: c.upstreamModel }
    if (ctx.stream) out.stream_options = { ...(body.stream_options as object | undefined), include_usage: true }
    const reqMaxCompletion = num(body.max_completion_tokens)
    const reqMax = num(body.max_tokens)
    if (c.providerID === "openai") {
      // OpenAI's reasoning models (o-series, gpt-5 and later) reject max_tokens outright.
      delete out.max_tokens
      const want = reqMaxCompletion ?? reqMax
      if (want !== undefined || s.outTokens < 8192) out.max_completion_tokens = Math.min(want ?? s.outTokens, s.outTokens)
    } else {
      if (reqMaxCompletion !== undefined) out.max_completion_tokens = Math.min(reqMaxCompletion, s.outTokens)
      if (reqMax !== undefined) out.max_tokens = Math.min(reqMax, s.outTokens)
      // Anthropic requires an output budget on every request.
      if (reqMax === undefined && reqMaxCompletion === undefined && (s.outTokens < 8192 || c.providerID === "anthropic")) out.max_tokens = s.outTokens
    }

    if (ctx.alias === "fast" && c.reasoning && body.reasoning_effort === undefined && body.reasoning === undefined) {
      if (c.providerID === "google" || c.providerID === "openai") out.reasoning_effort = "low"
      else if ((c.providerID === "groq" || c.providerID === "cerebras") && /gpt-oss/.test(c.modelID)) out.reasoning_effort = "low"
      else if (c.providerID === "openrouter") out.reasoning = { effort: "low" }
    }
    if ((c.providerID === "openai" || c.providerID === "openrouter") && body.prompt_cache_key === undefined) out.prompt_cache_key = ctx.sessionKey.slice(0, 64)

    const restored: Record<string, number> = {}
    if (c.providerID === "google") out.messages = continueNudge(out.messages)
    if (c.providerID === "google") {
      const r = sigs.restore(ctx.sessionKey, out.messages)
      out.messages = r.messages
      restored.signatures = r.restored
      restored.signatureSkips = r.skipped
    }
    if (c.interleaved) {
      const r = reasoning.restore(ctx.sessionKey, out.messages, c.interleaved)
      out.messages = r.messages
      restored.reasoning = r.restored
      restored.reasoningEmpty = r.empty
    }
    out.messages = nameModel(out.messages, c)
    return { out, restored }
  }

  function outboundHeaders(c: Candidate, ctx: Ctx): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` }
    if (c.providerID === "openrouter") {
      h["http-referer"] = "https://github.com/SyedSaribSultan/syrup"
      h["x-title"] = "syrup"
    }
    if (c.providerID === "fireworks-ai" && ctx.sessionId) h["x-session-affinity"] = ctx.sessionId
    return h
  }

  function responseHeaders(c: Candidate, attempt: number, reason: string, ctx: Ctx, contentType: string | null): Record<string, string> {
    return {
      "content-type": contentType ?? (ctx.stream ? "text/event-stream" : "application/json"),
      "cache-control": "no-cache",
      "x-syrup-provider": c.providerID,
      "x-syrup-model": c.modelID,
      "x-syrup-attempts": String(attempt),
      "x-syrup-request": ctx.reqID,
      "x-syrup-reason": reason,
    }
  }

  // ---------------------------------------------------------------- bookkeeping

  function failed(ctx: Ctx, c: Candidate, attempt: number, attemptStart: number, cls: Classified, httpStatus: number | null, waitedMs: number | null, body?: string): Failed {
    health.learn(c, cls)
    let retryAt = health.applyCooldown(c, cls)
    health.failure(c, cls, ctx.shape.promptTokens, waitedMs)
    if (cls.reason === "bad_request") retryAt = health.coolRepeatedBadRequests(c) ?? retryAt
    record({
      alias: ctx.alias,
      providerId: c.providerID,
      modelId: c.modelID,
      keyId: c.keyID,
      tier: c.tier,
      status: cls.status,
      httpStatus,
      attempts: attempt,
      latencyMs: now() - ctx.started,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      error: cls.message,
      sessionId: ctx.sessionId,
      ttftMs: null,
      retryAt,
      reason: cls.reason,
    })
    log(
      "router",
      `attempt.${cls.status}`,
      { reqID: ctx.reqID, attempt, backend: c.backend, key: c.keyID ?? (c.keyless ? "keyless" : "env"), httpStatus, reason: cls.reason, ms: now() - attemptStart, retryAt, message: cls.message },
      { level: "warn", sessionId: ctx.sessionId },
    )
    return { kind: "failed", c, cls, httpStatus, body }
  }

  function aborted(ctx: Ctx, c: Candidate, attempt: number, attemptStart: number, ttftMs: number | null, usage: Usage) {
    record({
      alias: ctx.alias,
      providerId: c.providerID,
      modelId: c.modelID,
      keyId: c.keyID,
      tier: c.tier,
      status: "aborted",
      httpStatus: null,
      attempts: attempt,
      latencyMs: now() - ctx.started,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cost: costOf(c, usage),
      error: null,
      sessionId: ctx.sessionId,
      ttftMs,
      retryAt: null,
      reason: "aborted",
    })
    log("router", "attempt.aborted", { reqID: ctx.reqID, attempt, backend: c.backend, ms: now() - attemptStart, ttftMs }, { sessionId: ctx.sessionId })
  }

  function succeeded(ctx: Ctx, c: Candidate, attempt: number, attemptStart: number, reason: string, ttftMs: number | null, genMs: number, tap: StreamTap, fail: StreamFail | null) {
    const usage = tap.usage
    const streamError = fail?.message ?? null
    if (fail?.reason === "truncated") {
      // Recorded as a partial answer so the chat can say so, but not held against the backend's health:
      // a provider that simply omits finish reasons must not cool down on every answer.
      health.success(c, ctx.shape.promptTokens, ttftMs, usage.completion_tokens ?? 0, genMs)
    } else if (fail) {
      // The first token came, so the backend does answer; the broken stream still counts against its health.
      health.success(c, ctx.shape.promptTokens, ttftMs, 0, 0)
      health.failure(c, { reason: "error", status: "error", scope: "none", retryAt: null, unhealthy: true, message: fail.message }, ctx.shape.promptTokens, null)
    } else health.success(c, ctx.shape.promptTokens, ttftMs, usage.completion_tokens ?? 0, genMs)
    sessions.stick(ctx.session, c.id, reason)
    sessions.recordOutput(ctx.session, usage.completion_tokens ?? 0)
    if (c.interleaved && tap.toolCallIds.length > 0) reasoning.remember(ctx.sessionKey, tap.toolCallIds, tap.reasoning)
    record({
      alias: ctx.alias,
      providerId: c.providerID,
      modelId: c.modelID,
      keyId: c.keyID,
      tier: c.tier,
      status: streamError ? "error" : "ok",
      httpStatus: 200,
      attempts: attempt,
      latencyMs: now() - ctx.started,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cost: costOf(c, usage),
      error: streamError,
      sessionId: ctx.sessionId,
      ttftMs,
      retryAt: null,
      reason: fail ? fail.reason : reason,
    })
    log(
      "router",
      streamError ? "attempt.stream_error" : "attempt.ok",
      { reqID: ctx.reqID, attempt, backend: c.backend, reason, ms: now() - attemptStart, ttftMs, usage, cost: costOf(c, usage), finish: tap.finishReason, error: streamError ?? undefined },
      { level: streamError ? "warn" : "info", sessionId: ctx.sessionId },
    )
    log("router", "request.done", { reqID: ctx.reqID, alias: ctx.alias, status: streamError ? "stream_error" : "ok", backend: c.backend, attempts: attempt, totalMs: now() - ctx.started, ttftMs, reason }, { sessionId: ctx.sessionId })
  }

  /** A success response said the request budget is used up: record the cooldown so the status view shows it. */
  function exhausted(ctx: Ctx, c: Candidate, attempt: number, cool: Cool) {
    const inMin = Math.max(1, Math.round((cool.until - now()) / 60_000))
    record({
      alias: ctx.alias,
      providerId: c.providerID,
      modelId: c.modelID,
      keyId: c.keyID,
      tier: c.tier,
      status: "rate_limited",
      httpStatus: 200,
      attempts: attempt,
      latencyMs: now() - ctx.started,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      error: `request budget used up (x-ratelimit-remaining-requests: 0); resets in ${inMin < 120 ? `${inMin} min` : `${(inMin / 60).toFixed(1)} h`}`,
      sessionId: ctx.sessionId,
      ttftMs: null,
      retryAt: cool.until,
      reason: cool.reason,
    })
  }

  // ---------------------------------------------------------------- one attempt

  async function attemptOnce(ctx: Ctx, s: Scored, attempt: number, deadlineMs: number, reason: string): Promise<AttemptResult> {
    const learned: { cool: Cool | null } = { cool: null }
    const r = await runAttempt(ctx, s, attempt, deadlineMs, reason, learned)
    // After the attempt's own event, so it is the backend's newest row.
    if (learned.cool) exhausted(ctx, s.c, attempt, learned.cool)
    return r
  }

  async function runAttempt(ctx: Ctx, s: Scored, attempt: number, deadlineMs: number, reason: string, learned: { cool: Cool | null }): Promise<AttemptResult> {
    const c = s.c
    const { res } = ctx
    const ac = new AbortController()
    ctx.setCurrent(ac)
    let timedOut = false
    let idled = false
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, deadlineMs)
    const { out, restored } = outboundBody(c, s, ctx)
    const attemptStart = now()
    log(
      "router",
      "attempt.start",
      { reqID: ctx.reqID, attempt, backend: c.backend, key: c.keyID ?? (c.keyless ? "keyless" : "env"), tier: c.tier, reason, deadlineMs: Math.round(deadlineMs), predTtftMs: Math.round(s.predTtftMs), maxTokens: out.max_tokens ?? out.max_completion_tokens, restored },
      { sessionId: ctx.sessionId },
    )
    health.begin(c)
    let ended = false
    const finish = () => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      health.end(c)
      ctx.setCurrent(null)
    }

    let upstream: Response
    try {
      upstream = await fetch(`${c.baseURL}/chat/completions`, { method: "POST", headers: outboundHeaders(c, ctx), body: JSON.stringify(out), signal: ac.signal })
    } catch (err) {
      finish()
      if (ctx.clientGone()) {
        aborted(ctx, c, attempt, attemptStart, null, {})
        return { kind: "aborted" }
      }
      const cls = timedOut ? classifyTimeout(deadlineMs, now()) : classifyNetwork(err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err), now())
      return failed(ctx, c, attempt, attemptStart, cls, null, timedOut ? deadlineMs : null)
    }
    const upHeaders = pickHeaders(upstream.headers)

    if (!upstream.ok) {
      let text = ""
      try {
        text = await upstream.text()
      } catch {}
      finish()
      if (ctx.clientGone()) {
        aborted(ctx, c, attempt, attemptStart, null, {})
        return { kind: "aborted" }
      }
      if (timedOut && !text) return failed(ctx, c, attempt, attemptStart, classifyTimeout(deadlineMs, now()), upstream.status, deadlineMs)
      const cls = classifyFailure({ status: upstream.status, headers: upHeaders, body: text, providerID: c.providerID, promptTokens: ctx.shape.promptTokens, now: now(), overloads: health.overloads(c) })
      return failed(ctx, c, attempt, attemptStart, cls, upstream.status, null, text)
    }

    learned.cool = health.learnHeaders(c, learnFromHeaders(upHeaders, now()))
    if (learned.cool) log("router", "backend.requests_exhausted", { reqID: ctx.reqID, backend: c.backend, until: learned.cool.until, reason: learned.cool.reason }, { sessionId: ctx.sessionId })
    const tap = new StreamTap(c.providerID === "google" ? (chunk) => sigs.harvest(ctx.sessionKey, chunk as Parameters<Signatures["harvest"]>[1]) : null, c.interleaved)
    const contentType = upstream.headers.get("content-type")

    // ------------------------------------------------ non-streaming: commit only once the whole answer is in
    if (!ctx.stream || !upstream.body) {
      let text: string
      try {
        text = await upstream.text()
      } catch (err) {
        finish()
        if (ctx.clientGone()) {
          aborted(ctx, c, attempt, attemptStart, null, {})
          return { kind: "aborted" }
        }
        const cls = timedOut ? classifyTimeout(deadlineMs, now()) : classifyNetwork(err instanceof Error ? err.message : String(err), now())
        return failed(ctx, c, attempt, attemptStart, cls, 200, timedOut ? deadlineMs : null)
      }
      finish()
      let j: { error?: { code?: unknown }; choices?: unknown } | null = null
      try {
        j = JSON.parse(text)
      } catch {}
      if (!j || j.error || !Array.isArray(j.choices)) {
        const code = typeof j?.error?.code === "number" ? j.error.code : 502
        const cls = j?.error ? classifyFailure({ status: code, headers: upHeaders, body: text, providerID: c.providerID, promptTokens: ctx.shape.promptTokens, now: now(), overloads: health.overloads(c) }) : classifyEmpty(now())
        return failed(ctx, c, attempt, attemptStart, cls, 200, null, text)
      }
      tap.observe(j)
      if (ctx.clientGone()) {
        aborted(ctx, c, attempt, attemptStart, null, tap.usage)
        return { kind: "aborted" }
      }
      if (chunkKind(j) !== "content") return failed(ctx, c, attempt, attemptStart, classifyEmpty(now(), emptyMessage(tap)), 200, null)
      succeeded(ctx, c, attempt, attemptStart, reason, null, 0, tap, null)
      res.writeHead(200, responseHeaders(c, attempt, reason, ctx, contentType))
      res.end(text)
      return { kind: "done" }
    }

    // ------------------------------------------------ streaming requested, JSON came back: an error in a 200, or a provider that ignored stream:true
    if (contentType?.includes("application/json")) {
      let text = ""
      try {
        text = await upstream.text()
      } catch {}
      finish()
      if (ctx.clientGone()) {
        aborted(ctx, c, attempt, attemptStart, null, {})
        return { kind: "aborted" }
      }
      if (timedOut && !text) return failed(ctx, c, attempt, attemptStart, classifyTimeout(deadlineMs, now()), 200, deadlineMs)
      const err = errorObject(text)
      const cls =
        err && text.includes('"error"')
          ? classifyFailure({ status: typeof err.code === "number" ? err.code : 502, headers: upHeaders, body: text, providerID: c.providerID, promptTokens: ctx.shape.promptTokens, now: now(), overloads: health.overloads(c) })
          : { ...classifyEmpty(now()), message: "provider answered without streaming" }
      return failed(ctx, c, attempt, attemptStart, cls, 200, null, text)
    }

    // ------------------------------------------------ streaming: buffer until the first meaningful event, then pipe
    const reader = upstream.body.getReader()
    const scanner = new SseScanner()
    const pending: Uint8Array[] = []
    let committed = false
    let ttftMs: number | null = null
    let firstAt = 0
    let embedded: { status: number; body: string } | null = null
    let streamError: string | null = null
    let caught: unknown = null

    const armIdle = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        idled = true
        ac.abort()
      }, timing.idleMs)
    }

    /**
     * Looks at parsed lines; returns true when one of them commits the response.
     * Only visible output commits: a finish reason, usage or [DONE] before any is an empty answer, which fails over.
     */
    const scan = (lines: SseLine[]): boolean => {
      let commit = false
      for (const line of lines) {
        if (line.kind !== "data") continue
        tap.observe(line.json)
        const kind = chunkKind(line.json)
        if (kind === "error") {
          const e = (line.json as { error?: { code?: unknown } }).error
          if (!committed && !commit) {
            embedded = { status: typeof e?.code === "number" ? e.code : 502, body: JSON.stringify(line.json) }
            return false
          }
          streamError = `upstream error event: ${(errorObject(JSON.stringify(line.json))?.message ?? "unknown").slice(0, 200)}`
        } else if (kind === "content") commit = true
      }
      return commit
    }

    const commitNow = async () => {
      committed = true
      // From here on the first-token deadline no longer applies; only upstream silence does.
      armIdle()
      ttftMs = now() - attemptStart
      firstAt = now()
      res.writeHead(200, responseHeaders(c, attempt, reason, ctx, contentType))
      const buffered = pending.splice(0)
      for (const p of buffered) await write(res, p)
    }

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        if (committed) {
          armIdle()
          scan(scanner.push(value))
          await write(res, value)
          continue
        }
        pending.push(value)
        const commit = scan(scanner.push(value))
        if (embedded) break
        if (commit) await commitNow()
      }
      if (!committed && !embedded && scan(scanner.flush())) await commitNow()
    } catch (err) {
      caught = err
    }
    finish()
    if (!committed || embedded) {
      ac.abort()
      reader.cancel().catch(() => {})
    }

    if (!committed) {
      if (ctx.clientGone()) {
        aborted(ctx, c, attempt, attemptStart, null, tap.usage)
        return { kind: "aborted" }
      }
      const e = embedded as { status: number; body: string } | null
      if (e) {
        const cls = classifyFailure({ status: e.status, headers: upHeaders, body: e.body, providerID: c.providerID, promptTokens: ctx.shape.promptTokens, now: now(), overloads: health.overloads(c) })
        return failed(ctx, c, attempt, attemptStart, cls, 200, null, e.body)
      }
      if (caught) {
        const cls = timedOut ? classifyTimeout(deadlineMs, now()) : classifyNetwork(caught instanceof Error ? caught.message : String(caught), now())
        return failed(ctx, c, attempt, attemptStart, cls, 200, timedOut ? deadlineMs : null)
      }
      return failed(ctx, c, attempt, attemptStart, classifyEmpty(now(), emptyMessage(tap)), 200, null)
    }

    // Committed: the client has (part of) an answer from this backend.
    if (ctx.clientGone()) {
      aborted(ctx, c, attempt, attemptStart, ttftMs, tap.usage)
      health.success(c, ctx.shape.promptTokens, ttftMs, 0, 0)
      sessions.stick(ctx.session, c.id, reason)
      return { kind: "done" }
    }
    let fail: StreamFail | null = streamError ? { reason: "stream_error", message: streamError } : null
    if (caught) {
      fail = idled
        ? { reason: "stream_idle", message: `upstream silent for ${Math.round(timing.idleMs / 1000)}s after the first token` }
        : { reason: "stream_error", message: `stream failed: ${caught instanceof Error ? caught.message : String(caught)}` }
    }
    // A clean close with no finish reason means the answer was cut off upstream. The engine sees finish
    // "unknown" and asks again in a new step, so the chat must be able to tell this answer stopped mid-way.
    if (!fail && !tap.finishReason) fail = { reason: "truncated", message: "upstream ended the stream without a finish reason" }
    succeeded(ctx, c, attempt, attemptStart, reason, ttftMs, now() - firstAt, tap, fail)
    res.end()
    return { kind: "done" }
  }

  // ---------------------------------------------------------------- failure responses

  function coolingResponse(res: http.ServerResponse, ctx: Pick<Ctx, "reqID" | "alias" | "sessionId">, total: number, soonest: number, detail: string[]) {
    const wait = Math.max(1, Math.ceil((soonest - now()) / 1000))
    log("router", "request.all_cooling_down", { reqID: ctx.reqID, alias: ctx.alias, waitSec: wait, detail }, { level: "warn", sessionId: ctx.sessionId })
    const lines = detail.length ? `\n${detail.map((d) => `- ${d}`).join("\n")}` : ""
    json(
      res,
      429,
      { error: { type: "syrup_all_cooling_down", message: `syrup router: all ${total} connected model${total === 1 ? " is" : "s are"} busy or rate limited right now. Retrying in ${fmtWait(wait)}.${lines}` } },
      { "retry-after": String(wait) },
    )
  }

  function fmtWait(sec: number): string {
    if (sec < 120) return `${sec}s`
    if (sec < 7200) return `${Math.round(sec / 60)} min`
    return `${(sec / 3600).toFixed(1)} h`
  }

  function contextResponse(res: http.ServerResponse, promptTokens: number) {
    // code + wording that OpenCode recognises as a context overflow, so it compacts the session and retries.
    json(res, 400, {
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: `syrup router: prompt is too long for every connected model (~${Math.round(promptTokens / 1000)}K tokens); maximum context length exceeded.`,
      },
    })
  }

  // ---------------------------------------------------------------- chat completions

  async function chatCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
    const started = now()
    const reqID = newId("rq", 6)
    // The response's close (not the request's, which ends once the body is read) tells us the client went away.
    let clientGone = false
    let current: AbortController | null = null
    res.on("close", () => {
      if (!res.writableFinished) {
        clientGone = true
        current?.abort()
      }
    })
    let raw: string
    try {
      raw = await readBody(req)
    } catch {
      return
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw)
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body is not an object")
    } catch {
      log("router", "request.bad_json", { reqID, bytes: raw.length }, { level: "warn" })
      return json(res, 400, { error: { message: "Invalid JSON body" } })
    }

    const requested = String(body.model ?? "auto").replace(/^syrup\//, "")
    const alias: Alias = requested in ALIASES ? (requested as Alias) : "auto"
    const stream = body.stream === true
    const messages: Msg[] = Array.isArray(body.messages) ? (body.messages as Msg[]) : []
    const sessionId = sessionHeader(req)
    const sKey = sessionKey(sessionId, messages)
    const session = sessions.touch(`${alias}:${sKey}`)

    let base: Candidate[]
    let unserved = 0
    try {
      const [cat, keys] = await Promise.all([store.catalog(), store.activeKeys()])
      const f = await served.filter(candidates.get(cat, keys))
      base = f.list
      unserved = f.dropped
    } catch (err) {
      log("router", "request.catalog_failed", { reqID, err }, { level: "error", sessionId })
      return json(res, 503, { error: { type: "syrup_catalog_unavailable", message: `syrup router: could not load the model catalog or keys (${err instanceof Error ? err.message : String(err)}). Retry in a moment.` } }, { "retry-after": "5" })
    }

    const est = estimatePromptTokens(raw.length, messages)
    const t = now()
    const diff = difficulty(alias, messages, session, t)
    const shape: RequestShape = {
      alias,
      promptTokens: est.tokens,
      requestedOut: num(body.max_completion_tokens) ?? num(body.max_tokens) ?? 8192,
      hasImage: est.hasImage,
      hard: diff.hard,
      hardWhy: diff.why,
      lastIsUser: messages[messages.length - 1]?.role === "user",
    }

    // Feasibility: static limits first, then what is cooling or busy right now.
    const excluded: Partial<Record<Exclusion, number>> = {}
    const staticOk: { c: Candidate; outTokens: number }[] = []
    const feasible: { c: Candidate; outTokens: number }[] = []
    let soonest = Infinity
    const coolingDetail = new Map<string, string>()
    for (const c of base) {
      const f = staticFit(c, shape, health)
      if (!f.ok) {
        excluded[f.why] = (excluded[f.why] ?? 0) + 1
        continue
      }
      staticOk.push({ c, outTokens: f.outTokens })
      const d = dynamicBlock(c, shape, f.outTokens, health, t)
      if (d && !d.ok) {
        excluded[d.why] = (excluded[d.why] ?? 0) + 1
        soonest = Math.min(soonest, d.until ?? t + 60_000)
        if (coolingDetail.size < 6) coolingDetail.set(c.backend, `${c.backend}: ${d.coolReason ?? d.why} for ${fmtWait(Math.max(1, Math.ceil(((d.until ?? t) - t) / 1000)))}`)
        continue
      }
      feasible.push({ c, outTokens: f.outTokens })
    }
    const ranked = rank(shape, feasible, session, health)
    const pick = applySticky(ranked, session, shape)

    log(
      "router",
      "request.received",
      {
        reqID,
        alias,
        requested,
        stream,
        messages: messages.length,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        promptTokens: shape.promptTokens,
        maxTokens: shape.requestedOut,
        image: shape.hasImage || undefined,
        hard: shape.hard,
        why: shape.hardWhy ?? undefined,
        session: sKey,
        sticky: session.sticky ?? undefined,
        pick: pick.reason,
        note: pick.note,
        candidates: base.length,
        feasible: feasible.length,
        excluded,
        unserved: unserved || undefined,
        top: pick.ordered.slice(0, 5).map((s) => `${s.c.backend}${s.c.keyless ? " (keyless)" : ""} ${s.score.toFixed(1)}`),
      },
      { sessionId },
    )

    if (base.length === 0) {
      log("router", "request.no_backend", { reqID, alias }, { level: "warn", sessionId })
      return json(res, 503, {
        error: { type: "syrup_no_backend", message: "syrup router: no connected provider can serve this request. Add an API key under Providers, or pick a model directly." },
      })
    }

    if (pick.ordered.length === 0) {
      if (staticOk.length > 0) return coolingResponse(res, { reqID, alias, sessionId }, staticOk.length, soonest, [...coolingDetail.values()])
      log("router", "request.infeasible", { reqID, alias, promptTokens: shape.promptTokens, excluded }, { level: "warn", sessionId })
      if (shape.hasImage && (excluded.vision ?? 0) === base.length) {
        return json(res, 400, { error: { type: "syrup_no_vision", message: "syrup router: none of your connected models accepts images. Remove the image or connect a provider with a vision model." } })
      }
      if ((excluded.context ?? 0) > 0) return contextResponse(res, shape.promptTokens)
      return json(res, 400, {
        error: {
          type: "syrup_request_too_large",
          message: `syrup router: this request (~${Math.round(shape.promptTokens / 1000)}K tokens) is larger than the tokens-per-minute limit of every connected free tier. Connect another provider or a paid key.`,
        },
      })
    }

    // Attempts.
    if (clientGone) return
    const ctx: Ctx = {
      reqID,
      alias,
      stream,
      body,
      shape,
      session,
      sessionId,
      sessionKey: sKey,
      started,
      res,
      clientGone: () => clientGone,
      setCurrent: (ac) => (current = ac),
    }
    const budget = stream ? timing.budgetMs : timing.nonStreamMs
    const failures: Failed[] = []
    const tried = new Set<string>()
    let budgetExceeded = false
    let attempt = 0
    // Context/TPM rejections come back in milliseconds and say nothing about health, so they do not use up the attempt budget.
    let counted = 0
    while (counted < MAX_ATTEMPTS && attempt < MAX_TOTAL_ATTEMPTS && !clientGone) {
      const elapsed = now() - started
      if (attempt > 0 && elapsed >= budget) {
        budgetExceeded = true
        break
      }
      // Re-check: an earlier attempt may have cooled a whole key (401) or a shared free-model cap.
      const tNow = now()
      const usable = pick.ordered.filter((s) => !tried.has(s.c.id) && !dynamicBlock(s.c, shape, s.outTokens, health, tNow) && staticFit(s.c, shape, health).ok)
      if (usable.length === 0) break
      const s = usable[0]
      tried.add(s.c.id)
      attempt++
      const isLast = usable.length === 1 || counted === MAX_ATTEMPTS - 1
      let deadline: number
      if (!stream) deadline = Math.max(1000, budget - elapsed)
      else if (isLast) deadline = timing.lastDeadlineMs
      else deadline = Math.min(clamp(2.5 * s.predTtftMs, timing.minDeadlineMs, timing.maxDeadlineMs), Math.max(budget - elapsed, timing.minDeadlineMs))
      const r = await attemptOnce(ctx, s, attempt, deadline, attempt === 1 ? pick.reason : "fallback")
      if (r.kind === "done" || r.kind === "aborted") return
      failures.push(r)
      if (r.cls.reason !== "context" && r.cls.reason !== "tpm") counted++
    }

    if (clientGone) {
      log("router", "request.aborted", { reqID, alias, attempts: attempt, totalMs: now() - started }, { sessionId })
      return
    }

    const summary = failures.map((f) => `${f.c.backend}: ${f.cls.message}`)
    log("router", "request.all_failed", { reqID, alias, attempts: attempt, budgetExceeded, failures: summary }, { level: "error", sessionId })

    const firstBad = failures.find((f) => f.cls.reason === "bad_request" && f.httpStatus === 400 && f.body)
    if (failures.length > 0 && failures.every((f) => f.cls.reason === "bad_request") && firstBad?.body) {
      res.writeHead(400, { "content-type": "application/json", "x-syrup-provider": firstBad.c.providerID, "x-syrup-model": firstBad.c.modelID, "x-syrup-attempts": String(attempt), "x-syrup-request": reqID })
      res.end(firstBad.body)
      return
    }
    if (failures.some((f) => f.cls.reason === "context") && failures.every((f) => f.cls.reason === "context" || f.cls.reason === "bad_request" || f.cls.reason === "tpm")) {
      return contextResponse(res, shape.promptTokens)
    }

    // Is everything that could take this request cooling down now?
    const tAfter = now()
    let soonestAfter = Infinity
    let allBlocked = staticOk.length > 0
    for (const { c, outTokens } of staticOk) {
      const d = dynamicBlock(c, shape, outTokens, health, tAfter)
      if (d && !d.ok) soonestAfter = Math.min(soonestAfter, d.until ?? tAfter + 60_000)
      else allBlocked = false
    }
    if (allBlocked && Number.isFinite(soonestAfter)) return coolingResponse(res, { reqID, alias, sessionId }, staticOk.length, soonestAfter, summary)

    const lines = summary.map((l) => `- ${l}`).join("\n")
    if (budgetExceeded) {
      return json(res, 504, {
        error: { type: "syrup_timeout", message: `syrup router: no model started answering within ${Math.round(budget / 1000)}s (${attempt} tried).\n${lines}` },
      })
    }
    json(res, 502, { error: { type: "syrup_all_backends_failed", message: `syrup router: every model tried failed for this request (${attempt} tried).\n${lines}` } })
  }

  return {
    async handle(req, res, url) {
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true })
        return true
      }
      if (!url.pathname.startsWith("/v1/")) return false
      if (!bearerOk(req, secret)) {
        log("router", "request.unauthorized", { method: req.method, path: url.pathname }, { level: "warn" })
        json(res, 401, { error: { message: "syrup router: missing or invalid bearer" } })
        return true
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        try {
          await chatCompletions(req, res)
        } catch (err) {
          log("router", "request.crashed", { err }, { level: "error" })
          if (!res.headersSent) json(res, 500, { error: { type: "syrup_router_error", message: `syrup router: internal error (${err instanceof Error ? err.message : String(err)})` } })
          else res.end()
        }
        return true
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        models(res)
        return true
      }
      if (req.method === "GET" && url.pathname === "/v1/status") {
        status(res)
        return true
      }
      return false
    },
  }
}
