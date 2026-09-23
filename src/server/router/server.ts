import crypto from "node:crypto"
import http from "node:http"
import { db, dbReady, schema } from "../db"
import { env } from "../env"
import { slog } from "../log"
import { handleMcp } from "../mcp"
import { ALIASES, candidates, type Alias, type Candidate } from "./backends"

/**
 * syrup router: an OpenAI-compatible endpoint the engine talks to as the
 * "syrup" provider. It picks a real backend for an alias, injects the key,
 * fails over on rate limits and errors, and records what actually ran.
 */

type Usage = { prompt_tokens?: number; completion_tokens?: number }

// providerID:keyID -> epoch ms until which we skip this backend.
const cooldown = new Map<string, number>()

function coolKey(c: Candidate) {
  return `${c.providerID}:${c.keyID ?? "env"}`
}

function retryAfterMs(res: Response): number {
  const h = res.headers.get("retry-after")
  if (h) {
    const s = Number(h)
    if (Number.isFinite(s)) return Math.min(s * 1000, 10 * 60_000)
    const d = Date.parse(h)
    if (Number.isFinite(d)) return Math.max(0, Math.min(d - Date.now(), 10 * 60_000))
  }
  return 60_000
}

function costOf(c: Candidate, u: Usage): number {
  if (c.tier === "free") return 0
  return ((u.prompt_tokens ?? 0) * c.price.input + (u.completion_tokens ?? 0) * c.price.output) / 1_000_000
}

async function record(row: typeof schema.routerEvents.$inferInsert) {
  try {
    await dbReady()
    await db().insert(schema.routerEvents).values(row)
  } catch (err) {
    slog("router", "ledger.write_failed", err, { level: "warn" })
  }
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = ""
    req.on("data", (c) => (s += c))
    req.on("end", () => resolve(s))
    req.on("error", reject)
  })
}

function pickHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ["content-type", "retry-after", "x-request-id", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "cf-ray", "date"]) {
    const v = h.get(k)
    if (v) out[k] = v
  }
  return out
}

/** Compact description of a chat request for the log: shape, not content. */
function summarize(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown; tool_calls?: unknown[] }[]) : []
  const last = messages[messages.length - 1]
  const roles: Record<string, number> = {}
  let chars = 0
  for (const m of messages) {
    roles[m.role ?? "?"] = (roles[m.role ?? "?"] ?? 0) + 1
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length
  }
  return {
    model: body.model,
    stream: body.stream === true,
    messages: messages.length,
    roles,
    approxChars: chars,
    tools: Array.isArray(body.tools) ? (body.tools as { function?: { name?: string } }[]).map((t) => t.function?.name).filter(Boolean) : [],
    lastRole: last?.role,
    lastToolCalls: Array.isArray(last?.tool_calls) ? last.tool_calls.length : 0,
    temperature: body.temperature,
    max_tokens: body.max_tokens ?? body.max_completion_tokens,
    reasoning_effort: body.reasoning_effort,
  }
}

/**
 * Gemini 3 requires each tool call's "thought signature" to be echoed back on
 * later turns. Google's OpenAI-compatible API carries it in
 * `tool_calls[].extra_content.google.thought_signature`, which generic OpenAI
 * clients drop. The router remembers signatures by tool-call id and restores
 * them; for calls it never saw it uses Google's documented skip value.
 */
const SIG_SKIP = "skip_thought_signature_validator"
const sigCache = new Map<string, string>()

function rememberSignature(id: string | undefined, sig: string | undefined) {
  if (!id || !sig) return
  if (sigCache.size > 5000) sigCache.delete(sigCache.keys().next().value as string)
  sigCache.set(id, sig)
}

type ToolCall = { id?: string; extra_content?: { google?: { thought_signature?: string } } } & Record<string, unknown>

function harvestSignatures(j: { choices?: { delta?: { tool_calls?: ToolCall[] }; message?: { tool_calls?: ToolCall[] } }[] }) {
  for (const ch of j.choices ?? []) {
    for (const tc of ch.delta?.tool_calls ?? ch.message?.tool_calls ?? []) rememberSignature(tc.id, tc.extra_content?.google?.thought_signature)
  }
}

/** Returns a copy of `messages` with signatures restored on assistant tool calls, and how many were restored/skipped. */
function restoreSignatures(messages: unknown): { messages: unknown; restored: number; skipped: number } {
  let restored = 0
  let skipped = 0
  if (!Array.isArray(messages)) return { messages, restored, skipped }
  const out = messages.map((m: { role?: string; tool_calls?: ToolCall[] }) => {
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) return m
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc) => {
        if (tc.extra_content?.google?.thought_signature) return tc
        const cached = sigCache.get(tc.id ?? "")
        if (cached) restored++
        else skipped++
        return { ...tc, extra_content: { ...tc.extra_content, google: { ...tc.extra_content?.google, thought_signature: cached ?? SIG_SKIP } } }
      }),
    }
  })
  return { messages: out, restored, skipped }
}

/** Pull `usage` (and Gemini thought signatures) out of an SSE stream as it passes through. */
function usageTap(onUsage: (u: Usage) => void, onChunk: () => void): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder()
  let buf = ""
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      onChunk()
      buf += dec.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (!data || data === "[DONE]") continue
        try {
          const j = JSON.parse(data)
          if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) onUsage(j.usage)
          harvestSignatures(j)
        } catch {}
      }
    },
  })
}

async function chatCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
  const started = Date.now()
  const reqID = `rq_${crypto.randomBytes(6).toString("hex")}`
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req))
  } catch (err) {
    slog("router", "request.bad_json", { reqID, err }, { level: "warn" })
    return json(res, 400, { error: { message: "Invalid JSON body" } })
  }

  const requested = String(body.model ?? "auto").replace(/^syrup\//, "")
  const alias: Alias = requested in ALIASES ? (requested as Alias) : "auto"
  const stream = body.stream === true
  if (stream) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true }
  const summary = summarize(body)

  const all = await candidates(alias)
  const now = Date.now()
  const cooling = all.filter((c) => (cooldown.get(coolKey(c)) ?? 0) >= now).map((c) => ({ backend: `${c.providerID}/${c.modelID}`, untilMs: (cooldown.get(coolKey(c)) ?? now) - now }))
  const list = all.filter((c) => (cooldown.get(coolKey(c)) ?? 0) < now)
  slog("router", "request.received", { reqID, alias, requested, ...summary, candidates: all.map((c) => `${c.providerID}/${c.modelID}[${c.tier}]`), cooling })

  if (all.length === 0) {
    slog("router", "request.no_backend", { reqID, alias }, { level: "warn" })
    return json(res, 503, {
      error: {
        type: "syrup_no_backend",
        message: "syrup router: no connected provider can serve this request. Add an API key under Providers, or pick a model directly.",
      },
    })
  }
  if (list.length === 0) {
    // Everything is cooling down after 429/5xx. Tell the engine when to come back.
    const soonest = Math.min(...all.map((c) => cooldown.get(coolKey(c)) ?? now))
    const wait = Math.max(1, Math.ceil((soonest - now) / 1000))
    slog("router", "request.all_cooling_down", { reqID, alias, waitSec: wait, cooling }, { level: "warn" })
    return json(
      res,
      429,
      {
        error: {
          type: "syrup_all_cooling_down",
          message: `syrup router: all ${all.length} connected model${all.length === 1 ? " is" : "s are"} busy or rate limited right now. Retrying in ${wait}s.`,
        },
      },
      { "retry-after": String(wait) },
    )
  }

  const errors: string[] = []
  let attempt = 0
  for (const c of list) {
    attempt++
    if (attempt > 4) break
    const backend = `${c.providerID}/${c.modelID}`
    const abort = new AbortController()
    req.on("close", () => abort.abort())
    const attemptStart = Date.now()
    let sig = { restored: 0, skipped: 0 }
    let outbound: Record<string, unknown> = { ...body, model: c.modelID }
    if (c.providerID === "google") {
      const r = restoreSignatures(body.messages)
      outbound = { ...outbound, messages: r.messages }
      sig = { restored: r.restored, skipped: r.skipped }
    }
    slog("router", "attempt.start", { reqID, attempt, backend, tier: c.tier, keyId: c.keyID, baseURL: c.baseURL, signatures: sig })

    let upstream: Response
    try {
      upstream = await fetch(`${c.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${c.apiKey}`,
          ...(c.providerID === "openrouter" ? { "http-referer": "https://github.com/SyedSaribSultan/syrup", "x-title": "syrup" } : {}),
        },
        body: JSON.stringify(outbound),
        signal: abort.signal,
      })
    } catch (err) {
      if (abort.signal.aborted) {
        slog("router", "attempt.client_aborted", { reqID, attempt, backend, ms: Date.now() - attemptStart })
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${backend}: ${msg}`)
      slog("router", "attempt.network_error", { reqID, attempt, backend, ms: Date.now() - attemptStart, error: msg }, { level: "warn" })
      continue
    }

    const headers = pickHeaders(upstream.headers)

    if (upstream.status === 429 || upstream.status >= 500) {
      const wait = upstream.status === 429 ? retryAfterMs(upstream) : 15_000
      cooldown.set(coolKey(c), Date.now() + wait)
      const text = await upstream.text().catch(() => "")
      errors.push(`${backend}: ${upstream.status} ${text.slice(0, 200)}`)
      slog("router", upstream.status === 429 ? "attempt.rate_limited" : "attempt.upstream_error", { reqID, attempt, backend, status: upstream.status, cooldownMs: wait, headers, body: text, ms: Date.now() - attemptStart }, { level: "warn" })
      void record({
        id: `rt_${crypto.randomBytes(8).toString("hex")}`,
        ts: Date.now(),
        alias,
        providerId: c.providerID,
        modelId: c.modelID,
        keyId: c.keyID,
        tier: c.tier,
        status: upstream.status === 429 ? "rate_limited" : "error",
        httpStatus: upstream.status,
        attempts: attempt,
        latencyMs: Date.now() - started,
        error: text.slice(0, 500),
      })
      continue
    }

    // Anything else (2xx or a 4xx that is the caller's problem) is passed through.
    const id = `rt_${crypto.randomBytes(8).toString("hex")}`
    let usage: Usage = {}
    let chunks = 0
    let firstByteMs: number | null = null
    const finish = (status: string, extra: Record<string, unknown> = {}) => {
      const latency = Date.now() - started
      slog("router", `attempt.${status}`, { reqID, attempt, backend, httpStatus: upstream.status, headers, ms: Date.now() - attemptStart, totalMs: latency, firstByteMs, chunks, usage, cost: costOf(c, usage), ...extra }, { level: status === "ok" ? "info" : "warn" })
      void record({
        id,
        ts: Date.now(),
        alias,
        providerId: c.providerID,
        modelId: c.modelID,
        keyId: c.keyID,
        tier: c.tier,
        status,
        httpStatus: upstream.status,
        attempts: attempt,
        latencyMs: latency,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cost: costOf(c, usage),
        error: typeof extra.body === "string" ? extra.body.slice(0, 500) : null,
      })
    }

    const outHeaders: Record<string, string> = {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-syrup-provider": c.providerID,
      "x-syrup-model": c.modelID,
      "x-syrup-attempts": String(attempt),
      "x-syrup-request": reqID,
    }
    if (stream) outHeaders["cache-control"] = "no-cache"
    res.writeHead(upstream.status, outHeaders)

    if (!upstream.body) {
      res.end()
      finish(upstream.ok ? "ok" : "error")
      return
    }

    if (!stream || !upstream.ok) {
      const text = await upstream.text()
      try {
        const j = JSON.parse(text)
        usage = j.usage ?? {}
        harvestSignatures(j)
      } catch {}
      res.end(text)
      finish(upstream.ok ? "ok" : "error", upstream.ok ? {} : { body: text })
      return
    }

    const tapped = upstream.body.pipeThrough(
      usageTap(
        (u) => (usage = u),
        () => {
          chunks++
          if (firstByteMs === null) firstByteMs = Date.now() - attemptStart
        },
      ),
    )
    const reader = tapped.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        res.write(value)
      }
      res.end()
      finish("ok")
    } catch (err) {
      res.end()
      finish(abort.signal.aborted ? "aborted" : "error", { error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  slog("router", "request.all_failed", { reqID, alias, attempts: attempt, errors }, { level: "error" })
  json(res, 502, {
    error: {
      type: "syrup_all_backends_failed",
      message: `syrup router: every backend failed or is rate limited.\n${errors.join("\n")}`,
    },
  })
}

function models(res: http.ServerResponse) {
  json(res, 200, {
    object: "list",
    data: Object.keys(ALIASES).map((id) => ({ id, object: "model", created: 0, owned_by: "syrup" })),
  })
}

const g = globalThis as unknown as { __syrupRouter?: Promise<string> }

/** Starts the router once per process and resolves to its base URL (…/v1). */
export function startRouter(): Promise<string> {
  if (!g.__syrupRouter) {
    g.__syrupRouter = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") return void chatCompletions(req, res)
        if (req.method === "GET" && url.pathname === "/v1/models") return models(res)
        if (url.pathname === "/mcp")
          return void handleMcp(req, res).catch((err) => {
            slog("mcp", "transport.error", err, { level: "error" })
            if (!res.headersSent) json(res, 500, { error: { message: String(err) } })
            else res.end()
          })
        if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true })
        slog("router", "request.unknown_route", { method: req.method, path: url.pathname }, { level: "warn" })
        json(res, 404, { error: { message: `syrup router: no route ${req.method} ${url.pathname}` } })
      })
      server.on("error", (err) => {
        g.__syrupRouter = undefined
        slog("router", "listen.error", err, { level: "error" })
        reject(err)
      })
      server.listen(env.routerPort, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${env.routerPort}/v1`
        console.log(`[syrup] router at ${url}`)
        slog("router", "listening", { url })
        resolve(url)
      })
    })
  }
  return g.__syrupRouter
}
