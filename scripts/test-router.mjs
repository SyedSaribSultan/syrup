#!/usr/bin/env node
/**
 * syrup router test suite. Bundles the router core with esbuild, drives it
 * through a real http.Server against mock upstream providers on 127.0.0.1,
 * and checks routing, failover, cooldowns, stickiness and body rewriting.
 *
 *   node scripts/test-router.mjs          (DEBUG=1 for router logs)
 *
 * Exits non-zero when any scenario fails.
 */
import { build } from "esbuild"
import { mkdirSync } from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const DEBUG = !!process.env.DEBUG
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "node_modules", ".cache", "syrup-router-test")
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, "router.mjs")
await build({
  stdin: {
    contents: [
      'export * from "./src/server/router/core"',
      'export * from "./src/server/router/upstream-errors"',
      'export { BASE_URL } from "./src/server/router/backends"',
      'export { applySticky, difficulty, estimatePromptTokens, trailingToolFailures } from "./src/server/router/policy"',
      'export { HttpRouterStore } from "./sidecar/store-http"',
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
    sourcefile: "router-test-entry.ts",
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
})
const R = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class AssertionError extends Error {}
function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg)
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new AssertionError(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
async function waitFor(fn, ms = 3000, msg = "condition") {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return
    await sleep(20)
  }
  throw new AssertionError(`timed out waiting for ${msg}`)
}
function readAll(req) {
  return new Promise((resolve) => {
    let s = ""
    req.on("data", (c) => (s += c))
    req.on("end", () => resolve(s))
  })
}

// ------------------------------------------------------------------ catalog + keys

function M(id, o = {}) {
  return {
    id,
    name: o.name ?? id,
    family: o.family,
    release_date: "2026-07-01",
    status: "active",
    capabilities: {
      toolcall: true,
      reasoning: o.reasoning ?? true,
      attachment: !!o.image,
      input: { text: true, image: !!o.image },
      interleaved: o.interleaved ?? false,
    },
    cost: o.cost ?? { input: 0, output: 0 },
    limit: { context: o.context ?? 1_048_576, output: o.output ?? 65_536 },
    ...(o.apiId ? { api: { id: o.apiId } } : {}),
    ...(o.options ? { options: o.options } : {}),
  }
}
const RC = { field: "reasoning_content" }

function baseCatalog(extra = {}) {
  const cat = new Map([
    [
      "google",
      new Map([
        ["gemini-3.8-flash", M("gemini-3.8-flash", { image: true, cost: { input: 0.75, output: 3.75 } })],
        ["gemini-3.5-flash-lite", M("gemini-3.5-flash-lite", { image: true, cost: { input: 0.3, output: 2.5 } })],
        ["gemini-3.1-pro-preview", M("gemini-3.1-pro-preview", { image: true, cost: { input: 2, output: 12 } })],
      ]),
    ],
    [
      "opencode",
      new Map([
        ["big-pickle", M("big-pickle", { context: 200_000, output: 32_000, interleaved: RC })],
        ["mimo-v2.6-flash-free", M("mimo-v2.6-flash-free", { context: 200_000, output: 32_000, image: true, interleaved: RC })],
        ["muse-spark-1.3-contributor-free", M("muse-spark-1.3-contributor-free", { image: true, output: 131_072 })],
      ]),
    ],
    ["groq", new Map([["openai/gpt-oss-120b", M("openai/gpt-oss-120b", { context: 131_072, output: 65_536, cost: { input: 0.15, output: 0.6 } })]])],
    ["nvidia", new Map([["moonshotai/kimi-k3", M("moonshotai/kimi-k3", { image: true, output: 131_072, interleaved: RC })]])],
  ])
  for (const [p, models] of Object.entries(extra)) for (const m of models) cat.get(p).set(m.id, m)
  return cat
}
const CATALOG = baseCatalog()

const K = {
  google: ["google", { id: "k_google", secret: "g-secret", tier: "free" }],
  opencode: ["opencode", { id: null, secret: "public", tier: "free" }],
  groq: ["groq", { id: "k_groq", secret: "groq-secret", tier: "free" }],
  nvidia: ["nvidia", { id: "k_nv", secret: "nv-secret", tier: "free" }],
}

// ------------------------------------------------------------------ mock upstream

const mock = (() => {
  const hits = []
  const persistent = new Map()
  const queued = new Map()
  // provider -> ids its GET /models lists; providers not set answer 404 (the router then filters nothing).
  const served = new Map()
  const server = http.createServer(async (req, res) => {
    const provider = req.url.split("/")[1]
    if (req.method === "GET" && req.url.endsWith("/models")) {
      const ids = served.get(provider)
      res.writeHead(ids ? 200 : 404, { "content-type": "application/json" })
      res.end(JSON.stringify(ids ? { data: ids.map((id) => ({ id })) } : { error: "not found" }))
      return
    }
    const raw = await readAll(req)
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    const hit = { provider, model: body.model, key: `${provider}/${body.model}`, body, headers: req.headers, closed: false, at: Date.now() }
    hits.push(hit)
    res.on("close", () => {
      if (!res.writableFinished) hit.closed = true
    })
    const q = queued.get(hit.key)
    const behave = (q && q.length ? q.shift() : undefined) ?? persistent.get(hit.key) ?? sseOk()
    try {
      await behave(req, res, hit)
    } catch (err) {
      if (DEBUG) console.log("mock behaviour error", err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  return {
    hits,
    server,
    url: "",
    set(key, fn) {
      persistent.set(key, fn)
    },
    once(key, fn) {
      if (!queued.has(key)) queued.set(key, [])
      queued.get(key).push(fn)
    },
    serve(provider, ids) {
      served.set(provider, ids)
    },
    reset() {
      hits.length = 0
      persistent.clear()
      queued.clear()
      served.clear()
    },
    of(key) {
      return hits.filter((h) => h.key === key)
    },
  }
})()
await new Promise((r) => mock.server.listen(0, "127.0.0.1", r))
mock.url = `http://127.0.0.1:${mock.server.address().port}`
const baseURLs = Object.fromEntries(["google", "opencode", "groq", "nvidia", "openrouter", "openai", "anthropic"].map((p) => [p, `${mock.url}/${p}`]))

/** Normal OpenAI-style SSE answer. Content says who answered. */
function sseOk(opts = {}) {
  return async (req, res, hit) => {
    const text = opts.text ?? `hello from ${hit.key}`
    if (!hit.body.stream) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "cmpl", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream", ...(opts.headers ?? {}) })
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    send({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })
    // firstDelayMs: a slow first token (the role delta is already out, so this is pure time-to-first-content).
    if (opts.firstDelayMs) await sleep(opts.firstDelayMs)
    if (hit.closed) return
    if (opts.reasoning) {
      for (const part of opts.reasoning.match(/.{1,8}/g)) send({ id: "c", choices: [{ index: 0, delta: { reasoning_content: part } }] })
    }
    const parts = opts.chunks ?? [text]
    for (const part of parts) {
      if (hit.closed) return
      send({ id: "c", choices: [{ index: 0, delta: { content: part } }] })
      if (opts.delayMs) await sleep(opts.delayMs)
    }
    if (opts.toolCall) send({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: opts.toolCall, type: "function", function: { name: "read", arguments: "{}" } }] } }] })
    // noFinish: the upstream closes cleanly after the content, with no finish reason (a cut-off answer).
    if (opts.noFinish) return void res.end()
    send({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: opts.toolCall ? "tool_calls" : "stop" }] })
    send({ id: "c", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })
    res.write("data: [DONE]\n\n")
    res.end()
  }
}
function status(code, body, headers = {}) {
  return async (req, res) => {
    res.writeHead(code, { "content-type": "application/json", ...headers })
    res.end(typeof body === "string" ? body : JSON.stringify(body))
  }
}
/** 200 + SSE keep-alive comments forever, never any content. */
function keepAliveForever() {
  return async (req, res, hit) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(": OPENROUTER PROCESSING\n\n")
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (hit.closed) {
          clearInterval(t)
          return resolve()
        }
        res.write(": OPENROUTER PROCESSING\n\n")
      }, 100)
      res.on("close", () => {
        clearInterval(t)
        resolve()
      })
    })
  }
}
/** A role-only delta, then silence. */
function roleThenStall() {
  return async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`)
    await new Promise((resolve) => res.on("close", resolve))
  }
}

const GOOGLE_PER_DAY = [
  {
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan and billing details.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }],
        },
        { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Learn more", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
      ],
    },
  },
]
const GOOGLE_PER_MINUTE = [
  {
    error: {
      code: 429,
      message: "Resource has been exhausted (e.g. check quota).",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "10" }],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" },
      ],
    },
  },
]

// ------------------------------------------------------------------ router under test

const SECRET = "test-secret"
const TIMING = { minDeadlineMs: 800, maxDeadlineMs: 1500, lastDeadlineMs: 3000, budgetMs: 8000, idleMs: 2000, nonStreamMs: 5000, hedgeMinMs: 300, hedgeMaxMs: 400 }

/** A chat that already has one answered turn: the sticky/deadline paths, without the opening turn's speed pick and hedge. */
function continuation(user) {
  return [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "hello" },
    { role: "assistant", content: "Hi. What should I do?" },
    { role: "user", content: user },
  ]
}

async function makeRouter({ keys, catalog = CATALOG, timing = TIMING, now } = {}) {
  const events = []
  const logs = []
  const store = {
    catalog: async () => catalog,
    activeKeys: async () => new Map(keys),
    record: async (e) => {
      events.push(e)
    },
  }
  const log = (source, event, data, opts) => {
    logs.push({ source, event, data, opts })
    if (DEBUG) console.log(`  [${source}] ${event}`, JSON.stringify(data))
  }
  const router = R.createRouter({ store, log, secret: SECRET, baseURLs, timing, now })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    void router.handle(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    events,
    logs,
    received: () => logs.filter((l) => l.event === "request.received").map((l) => l.data),
    async status() {
      const r = await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${SECRET}` } })
      return r.json()
    },
    close() {
      server.closeAllConnections?.()
      return new Promise((r) => server.close(r))
    },
  }
}

function parseSse(text) {
  let content = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const d = line.slice(5).trim()
    if (!d || d === "[DONE]") continue
    try {
      const j = JSON.parse(d)
      for (const ch of j.choices ?? []) if (typeof ch.delta?.content === "string") content += ch.delta.content
    } catch {}
  }
  return content
}

async function chat(router, { alias = "auto", messages, user, stream = true, headers = {}, max_tokens = 32000, signal, extra = {} }) {
  const msgs = messages ?? [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: user ?? "add a README file" },
  ]
  const res = await fetch(`${router.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: `syrup/${alias}`, messages: msgs, stream, max_tokens, ...extra }),
    signal,
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, content: stream ? parseSse(text) : text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

/** A clock the router reads for cooldowns, decay and TTLs; tests move it forward by hand. */
function fakeClock(start = Date.now()) {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
  }
}

/** Assistant tool call + its result, as OpenCode sends a tool-call continuation. */
function toolTurn(id, result) {
  return [
    { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: result },
  ]
}

const QUALITY_STRONG_FREE = new Set(["opencode/mimo-v2.6-flash-free", "opencode/big-pickle", "opencode/muse-spark-1.3-contributor-free"])

// ------------------------------------------------------------------ scenarios

const results = []
async function scenario(name, fn) {
  const t0 = Date.now()
  mock.reset()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}: ${err instanceof AssertionError ? err.message : err?.stack ?? err}`)
  }
}

await scenario("unit: duration, reset and Pacific-midnight parsing", async () => {
  eq(R.parseDuration("2m59.56s"), 179_560, "2m59.56s")
  eq(R.parseDuration("120ms"), 120, "120ms")
  eq(R.parseDuration("1.2s"), 1200, "1.2s")
  eq(R.parseDuration("1h2m3s"), 3_723_000, "1h2m3s")
  eq(R.parseDuration("7"), 7000, "bare seconds")
  eq(R.parseReset("1760000000000", 0), 1_760_000_000_000, "epoch ms reset")
  // 2026-09-27 15:00 PDT (UTC-7) → next midnight PT = 2026-09-28 07:00 UTC.
  eq(R.nextPacificMidnight(Date.UTC(2026, 8, 27, 22, 0, 0)), Date.UTC(2026, 8, 28, 7, 0, 0), "PDT midnight")
  // 2026-12-01 10:00 PST (UTC-8) → 2026-12-02 08:00 UTC.
  eq(R.nextPacificMidnight(Date.UTC(2026, 11, 1, 18, 0, 0)), Date.UTC(2026, 11, 2, 8, 0, 0), "PST midnight")
  // DST ends 2026-11-01 02:00 PDT: from 2026-10-31 20:00 PDT the next midnight is 2026-11-01 00:00 PDT = 07:00 UTC.
  eq(R.nextPacificMidnight(Date.UTC(2026, 10, 1, 3, 0, 0)), Date.UTC(2026, 10, 1, 7, 0, 0), "midnight before DST end")
  // From 2026-11-01 12:00 PST the next is 2026-11-02 00:00 PST = 08:00 UTC.
  eq(R.nextPacificMidnight(Date.UTC(2026, 10, 1, 20, 0, 0)), Date.UTC(2026, 10, 2, 8, 0, 0), "midnight after DST end")
  eq(R.nextUtcMidnight(Date.UTC(2026, 8, 27, 22, 0, 0)), Date.UTC(2026, 8, 28), "UTC midnight")
})

await scenario("unit: classifyFailure covers every limit type", async () => {
  const now = Date.UTC(2026, 8, 27, 22, 0, 0)
  const base = { headers: {}, promptTokens: 10_000, now }
  const perDay = R.classifyFailure({ ...base, status: 429, body: JSON.stringify(GOOGLE_PER_DAY), providerID: "google" })
  eq(perDay.reason, "rpd", "google PerDay reason")
  eq(perDay.scope, "backend", "google PerDay scope")
  eq(perDay.retryAt, Date.UTC(2026, 8, 28, 7, 0, 0), "google PerDay retryAt")
  const perMin = R.classifyFailure({ ...base, status: 429, body: JSON.stringify(GOOGLE_PER_MINUTE), providerID: "google" })
  eq(perMin.reason, "rpm", "google PerMinute reason")
  eq(perMin.retryAt, now + 37_000, "google PerMinute retryAt")
  const orDay = R.classifyFailure({ ...base, status: 429, body: JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", code: 429 } }), providerID: "openrouter" })
  eq(orDay.reason, "rpd", "openrouter per-day reason")
  const antCtx = R.classifyFailure({ ...base, status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "input length and `max_tokens` exceed context limit: 180000 + 32000 > 200000" } }), providerID: "anthropic" })
  eq(antCtx.reason, "context", "anthropic max_tokens overflow is a context error")
  eq(orDay.scope, "keyFree", "openrouter per-day scope")
  eq(orDay.retryAt, Date.UTC(2026, 8, 28), "openrouter per-day retryAt")
  const generic = R.classifyFailure({ ...base, status: 429, body: "{}", headers: { "retry-after": "12" }, providerID: "mistral" })
  eq(generic.reason, "rpm", "generic 429 reason")
  eq(generic.retryAt, now + 12_000, "generic retry-after")
  const daily = R.classifyFailure({ ...base, status: 429, body: JSON.stringify({ error: { message: "daily request limit reached" } }), providerID: "cohere" })
  eq(daily.reason, "rpd", "daily body")
  const groqTpm = R.classifyFailure({ ...base, status: 413, body: JSON.stringify({ error: { message: "Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 50000" } }), headers: { "x-ratelimit-limit-tokens": "8000" }, providerID: "groq" })
  eq(groqTpm.reason, "tpm", "groq TPM reason")
  eq(groqTpm.learnedTpm, 8000, "groq learned TPM")
  eq(groqTpm.retryAt, null, "groq too-large has no cooldown")
  const ctx = R.classifyFailure({ ...base, status: 400, body: JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens" } }), providerID: "nvidia" })
  eq(ctx.reason, "context", "context reason")
  eq(ctx.learnedMaxPrompt, 9500, "learned max prompt")
  eq(ctx.retryAt, null, "context has no cooldown")
  const bad = R.classifyFailure({ ...base, status: 400, body: JSON.stringify({ error: { message: "Invalid value for tool_choice" } }), providerID: "nvidia" })
  eq(bad.reason, "bad_request", "bad request")
  eq(bad.scope, "none", "bad request not cooled")
  const auth = R.classifyFailure({ ...base, status: 401, body: "{}", providerID: "google" })
  eq(auth.reason, "auth", "auth")
  eq(auth.scope, "key", "auth scope")
  eq(auth.retryAt, now + 600_000, "auth 10 min")
  const nf = R.classifyFailure({ ...base, status: 404, body: JSON.stringify({ error: { message: "This model models/gemini-2.5-flash is no longer available" } }), providerID: "google" })
  eq(nf.retryAt, now + 86_400_000, "404 out for the day")
  eq(nf.scope, "backend", "404 cools only that model")
  eq(nf.unhealthy, false, "404 is the catalog's fault, not the model's health")
  const gated = R.classifyFailure({ ...base, status: 403, body: JSON.stringify({ error: { message: "thinkingmachines/inkling:free is only available on the Pro plan" } }), providerID: "openrouter" })
  eq(gated.scope, "backend", "model-specific 403 cools only that model")
  eq(gated.reason, "error", "model-specific 403 is not an auth failure")
  eq(gated.retryAt, now + 3_600_000, "model-specific 403 1 h")
  const keyBad = R.classifyFailure({ ...base, status: 403, body: JSON.stringify({ error: { message: "Unauthorized: this API key has been disabled" } }), providerID: "openrouter" })
  eq(keyBad.reason, "auth", "403 blaming the key is auth")
  eq(keyBad.scope, "key", "403 blaming the key cools the key")
  const noThink = R.classifyFailure({ ...base, status: 400, body: JSON.stringify({ error: { message: "Thinking level is not supported for this model.", code: 400, status: "INVALID_ARGUMENT" } }), providerID: "google" })
  eq(noThink.reason, "bad_request", "thinking rejection is a bad request")
  eq(noThink.learnedNoReasoningParam, true, "thinking rejection is learned")
  eq(noThink.scope, "none", "thinking rejection cools nothing")
  const o1 = R.classifyFailure({ ...base, status: 503, body: JSON.stringify({ error: { message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }), providerID: "google" })
  eq(o1.reason, "overloaded", "503 overloaded")
  eq(o1.retryAt, now + 30_000, "first overload 30 s")
  const o3 = R.classifyFailure({ ...base, status: 503, body: "{}", providerID: "google", overloads: 2 })
  eq(o3.retryAt, now + 120_000, "third overload doubles to 120 s")
  const o9 = R.classifyFailure({ ...base, status: 500, body: "{}", providerID: "google", overloads: 9 })
  eq(o9.retryAt, now + 300_000, "overload capped at 5 min")
  const hd = R.classifyFailure({ ...base, status: 400, body: JSON.stringify({ error: { message: "high demand right now" } }), providerID: "opencode" })
  eq(hd.reason, "overloaded", "high-demand body")
  const learned = R.learnFromHeaders({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "2m59.56s", "x-ratelimit-limit-tokens": "8000" }, now)
  eq(learned.remainingRequests, 0, "remaining requests")
  eq(learned.resetRequestsAt, now + 179_560, "groq reset string")
  eq(learned.limitTokens, 8000, "limit tokens")
})

await scenario("unit: turn difficulty heuristics", async () => {
  const s = { key: "x", sticky: null, stickyAt: 0, outEwma: 600, escalatedUntil: 0, lastSeen: 0 }
  eq(R.difficulty("auto", [{ role: "user", content: "add a readme" }], s, 0).hard, false, "routine turn")
  eq(R.difficulty("auto", [{ role: "user", content: "Plan the auth module" }], s, 0).why, "keyword:plan", "plan keyword")
  eq(R.difficulty("fast", [{ role: "user", content: "debug this" }], s, 0).hard, false, "fast never hard")
  const failing = [{ role: "user", content: "run tests" }, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "Error: ENOENT" }, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "SyntaxError: Unexpected token" }]
  eq(R.trailingToolFailures(failing), 2, "two trailing failures")
  const d = R.difficulty("auto", failing, s, 1000)
  eq(d.why, "tool_failures:2", "escalates on failures")
  assert(s.escalatedUntil === 1000 + 600_000, "escalated for 10 minutes")
  eq(R.difficulty("auto", [{ role: "user", content: "ok thanks" }, { role: "assistant", content: "hi" }], s, 5000).why, "escalated", "stays escalated")
})

await scenario("unit: substantial asks are hard, judged from the latest user message for every step of the turn", async () => {
  const s = { key: "x", sticky: null, stickyAt: 0, stickyByFallback: false, outEwma: 600, escalatedUntil: 0, lastSeen: 0 }
  const brief =
    "I'm working on a big project and need sample brands to test an image generator that is meant to be good at ads. " +
    "Help me create a whole campaign: one large document with prompts for image ads and video ads. Start with one product, " +
    "a new cereal inspired by a superhero series that just came out. Build the full brand around it, the product, the packaging, " +
    "the look and the voice, and give me very detailed prompts for each format so I can compare how the generator handles them. " +
    "Keep it to one product for now and we can add more brands later once this one works."
  const d = R.difficulty("auto", [{ role: "user", content: brief }], s, 0)
  eq(d.hard, true, "a long, detailed creative brief is hard")
  assert(d.why?.startsWith("work:"), `why: ${d.why}`)
  eq(R.difficulty("auto", [{ role: "user", content: "write a haiku about rain" }], s, 0).hard, false, "one work signal is routine")
  eq(R.difficulty("auto", [{ role: "user", content: "create a complete README for this repo" }], s, 0).hard, true, "produce + depth is hard")
  const continuing = [{ role: "user", content: brief }, { role: "assistant", content: "Here is the campaign. # 1. Brand" }]
  eq(R.difficulty("auto", continuing, s, 0).hard, true, "a continuation step keeps the turn's verdict")
  eq(R.difficulty("auto", [...continuing, { role: "user", content: "thanks!" }], s, 0).hard, false, "the next user message is judged on its own")
})

await scenario("unit: a failover backend never carries into the next user turn", async () => {
  const mk = (id, score, quality) => ({ c: { id, info: { quality, grade: "strong" }, scarce: false, costs: null }, score, predMs: 5000, predTtftMs: 2000, outTokens: 1000 })
  const ranked = [mk("google/flash", 47.0, 88), mk("google/flash-lite", 46.9, 55)]
  const session = { key: "x", sticky: "google/flash-lite", stickyAt: 0, stickyByFallback: true, outEwma: 600, escalatedUntil: 0, lastSeen: 0 }
  const turn = R.applySticky(ranked, session, { alias: "auto", hard: false, lastIsUser: true })
  eq(turn.ordered[0].c.id, "google/flash", "fresh pick on the new user message")
  eq(turn.note, "released_fallback", "released")
  const step = R.applySticky(ranked, session, { alias: "auto", hard: false, lastIsUser: false })
  eq(step.ordered[0].c.id, "google/flash-lite", "mid-turn steps stay on the backend that is answering")
  const chosen = R.applySticky(ranked, { ...session, stickyByFallback: false }, { alias: "auto", hard: false, lastIsUser: true })
  eq(chosen.ordered[0].c.id, "google/flash-lite", "a backend that won on merit stays sticky within the margin")
})

await scenario("gemini: a request ending with a partial answer gets a continue turn; tool-call endings don't", async () => {
  const r = await makeRouter({ keys: [K.google] })
  try {
    const partial = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "add a README file" },
      { role: "assistant", content: "Here is the README. ## Install" },
    ]
    const one = await chat(r, { messages: partial })
    eq(one.status, 200, "status")
    const sent = mock.hits.at(-1).body.messages
    eq(mock.hits.at(-1).provider, "google", "google served")
    eq(sent.length, 4, "one message added")
    eq(sent.at(-1).role, "user", "ends with a user turn")
    assert(/^Continue exactly where/.test(sent.at(-1).content), "asks to continue")
    const toolEnd = [
      { role: "user", content: "add a README file" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_g1", type: "function", function: { name: "read", arguments: "{}" } }] },
    ]
    await chat(r, { messages: toolEnd })
    eq(mock.hits.at(-1).body.messages.length, 2, "tool-call ending left alone")
  } finally {
    await r.close()
  }
})

await scenario("a) normal turn → non-scarce strong free model; plan/debug turn → gemini-3.8-flash", async () => {
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const normal = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_a1" } })
    eq(normal.status, 200, "normal status")
    const pick = `${normal.headers.get("x-syrup-provider")}/${normal.headers.get("x-syrup-model")}`
    assert(QUALITY_STRONG_FREE.has(pick), `normal turn picked ${pick}, wanted a strong keyless Zen model`)
    const planned = await chat(r, { user: "plan the architecture for the billing module", headers: { "x-session-affinity": "ses_a2" } })
    eq(`${planned.headers.get("x-syrup-provider")}/${planned.headers.get("x-syrup-model")}`, "google/gemini-3.8-flash", "plan turn")
    const debug = await chat(r, { user: "debug the failing login test", headers: { "x-session-affinity": "ses_a3" } })
    eq(debug.headers.get("x-syrup-model"), "gemini-3.8-flash", "debug turn")
    const rec = r.received()
    eq(rec[0].hard, false, "normal logged not hard")
    eq(rec[1].hard, true, "plan logged hard")
    eq(rec[1].why, "keyword:plan", "plan logged why")
    assert(Array.isArray(rec[0].top) && rec[0].top.length > 0 && !rec[0].top.join(" ").includes("secret"), "top candidates logged without keys")
  } finally {
    await r.close()
  }
})

await scenario("a2) with NVIDIA free, a normal turn prefers glm-5.3 when its predicted time is reasonable", async () => {
  const catalog = baseCatalog({ nvidia: [M("z-ai/glm-5.3", { context: 200_000, output: 131_072 })] })
  const r = await makeRouter({ keys: [K.google, K.opencode, K.nvidia], catalog })
  try {
    const res = await chat(r, { messages: continuation("rename the variable"), headers: { "x-session-affinity": "ses_a2b" } })
    eq(`${res.headers.get("x-syrup-provider")}/${res.headers.get("x-syrup-model")}`, "nvidia/z-ai/glm-5.3", "nvidia pick")
  } finally {
    await r.close()
  }
})

await scenario("b) the same session sticks to its backend; a hard turn escalates", async () => {
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const h = { "x-session-affinity": "ses_b" }
    const one = await chat(r, { user: "add a README file", headers: h })
    const two = await chat(r, { messages: [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "add a README file" }, { role: "assistant", content: "done" }, { role: "user", content: "now add a license" }], headers: h })
    eq(two.headers.get("x-syrup-model"), one.headers.get("x-syrup-model"), "second turn same model")
    const okEvents = r.events.filter((e) => e.status === "ok")
    eq(okEvents[0].reason, "best", "first turn reason")
    eq(okEvents[1].reason, "sticky", "second turn reason")
    const three = await chat(r, { messages: [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "debug why the build fails" }], headers: h })
    eq(three.headers.get("x-syrup-model"), "gemini-3.8-flash", "hard turn escalates")
    eq(r.events.filter((e) => e.status === "ok")[2].reason, "escalated", "escalated reason")
  } finally {
    await r.close()
  }
})

await scenario("c) Gemini 429 PerDay cools only that model until Pacific midnight; another Google model serves", async () => {
  const r = await makeRouter({ keys: [K.google] })
  try {
    mock.set("google/gemini-3.8-flash", status(429, GOOGLE_PER_DAY))
    const t0 = Date.now()
    const res = await chat(r, { user: "plan the data model", headers: { "x-session-affinity": "ses_c" } })
    eq(res.status, 200, "status after failover")
    eq(res.headers.get("x-syrup-model"), "gemini-3.5-flash-lite", "served by another google model")
    const ev = r.events.find((e) => e.modelId === "gemini-3.8-flash")
    eq(ev.reason, "rpd", "event reason")
    eq(ev.status, "rate_limited", "event status")
    const expected = R.nextPacificMidnight(ev.ts)
    eq(ev.retryAt, expected, "retryAt is next Pacific midnight")
    const la = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(ev.retryAt))
    eq(la, "00:00", "retryAt is 00:00 in Los Angeles")
    assert(ev.retryAt > t0 && ev.retryAt - t0 <= 25 * 3600_000, "retryAt within a day")
    const before = mock.of("google/gemini-3.8-flash").length
    const again = await chat(r, { user: "plan the api", headers: { "x-session-affinity": "ses_c2" } })
    eq(again.headers.get("x-syrup-model"), "gemini-3.5-flash-lite", "next request skips the cooled model")
    eq(mock.of("google/gemini-3.8-flash").length, before, "cooled model not called again")
    const st = await r.status()
    assert(st.cooldowns.some((c) => c.scope.includes("gemini-3.8-flash") && c.reason === "rpd"), "status shows the rpd cooldown")
    assert(!st.cooldowns.some((c) => c.scope.startsWith("k:google")), "google key itself not cooled")
  } finally {
    await r.close()
  }
})

await scenario("d) PerMinute 429 cools for about retryDelay", async () => {
  const r = await makeRouter({ keys: [K.google] })
  try {
    mock.set("google/gemini-3.8-flash", status(429, GOOGLE_PER_MINUTE))
    const res = await chat(r, { user: "plan the queue", headers: { "x-session-affinity": "ses_d" } })
    eq(res.status, 200, "failover status")
    const ev = r.events.find((e) => e.modelId === "gemini-3.8-flash")
    eq(ev.reason, "rpm", "reason")
    const delta = ev.retryAt - ev.ts
    assert(delta > 35_000 && delta < 39_000, `retryAt ≈ now + 37 s (got ${delta} ms)`)
  } finally {
    await r.close()
  }
})

await scenario("e) 503 → invisible failover; client sees only the second backend", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", status(503, { error: { message: "The model is overloaded" } }))
    const res = await chat(r, { user: "add a README file" })
    eq(res.status, 200, "client status")
    const second = `${res.headers.get("x-syrup-provider")}/${res.headers.get("x-syrup-model")}`
    assert(second !== "opencode/mimo-v2.6-flash-free", "served by another backend")
    eq(res.content, `hello from ${second}`, "only the second backend's content")
    eq(res.headers.get("x-syrup-attempts"), "2", "two attempts")
    const [first, ok] = r.events
    eq(first.reason, "overloaded", "first event reason")
    eq(first.httpStatus, 503, "first event status")
    assert(first.retryAt && first.retryAt - first.ts >= 29_000, "overload cooldown set")
    eq(ok.status, "ok", "second event ok")
    eq(ok.reason, "fallback", "second event reason")
    assert(typeof ok.ttftMs === "number", "ttft recorded")
  } finally {
    await r.close()
  }
})

await scenario("f) keep-alive comments without content past the deadline → abort + failover", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", keepAliveForever())
    const t0 = Date.now()
    const res = await chat(r, { messages: continuation("add a README file") })
    eq(res.status, 200, "status")
    assert(res.headers.get("x-syrup-model") !== "mimo-v2.6-flash-free", "failed over")
    assert(!res.text.includes("OPENROUTER PROCESSING"), "keep-alives never reached the client")
    const ev = r.events.find((e) => e.modelId === "mimo-v2.6-flash-free")
    eq(ev.reason, "timeout", "timeout reason")
    eq(ev.status, "timeout", "timeout status")
    assert(Date.now() - t0 < 4000, "deadline respected")
    await waitFor(() => mock.of("opencode/mimo-v2.6-flash-free")[0]?.closed, 2000, "upstream closed")
  } finally {
    await r.close()
  }
})

await scenario("g) a role-only delta then a stall is not a commit", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
    const res = await chat(r, { messages: continuation("add a README file") })
    eq(res.status, 200, "status")
    const second = `${res.headers.get("x-syrup-provider")}/${res.headers.get("x-syrup-model")}`
    assert(second !== "opencode/mimo-v2.6-flash-free", "failed over")
    eq(res.content, `hello from ${second}`, "client content only from the second backend")
    eq(r.events.find((e) => e.modelId === "mimo-v2.6-flash-free").reason, "timeout", "stalled attempt timed out")
  } finally {
    await r.close()
  }
})

await scenario("h) context-length 400 → next candidate, no cooldown, learned limit", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", status(400, { error: { message: "This model's maximum context length is 200000 tokens. However, your messages resulted in 210000 tokens." } }))
    const big = "x".repeat(40_000)
    const res = await chat(r, { user: `add a README file ${big}` })
    eq(res.status, 200, "status")
    assert(res.headers.get("x-syrup-model") !== "mimo-v2.6-flash-free", "next candidate served")
    const ev = r.events.find((e) => e.modelId === "mimo-v2.6-flash-free")
    eq(ev.reason, "context", "reason")
    eq(ev.retryAt, null, "no cooldown")
    const st = await r.status()
    assert(!st.cooldowns.some((c) => c.scope.includes("mimo")), "mimo not cooling")
    assert(st.learned.some((l) => l.id.includes("mimo") && l.maxPrompt > 0), "learned max prompt")
    const hits = mock.of("opencode/mimo-v2.6-flash-free").length
    await chat(r, { user: `add a README file ${big}` })
    eq(mock.of("opencode/mimo-v2.6-flash-free").length, hits, "same-size prompt skips mimo")
    await chat(r, { messages: continuation("tiny"), headers: { "x-session-affinity": "ses_h_small" } })
    eq(mock.of("opencode/mimo-v2.6-flash-free").length, hits + 1, "small prompt still uses mimo")
  } finally {
    await r.close()
  }
})

await scenario("i) 401 cools the provider key; other providers serve", async () => {
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    mock.set("google/gemini-3.8-flash", status(401, { error: { message: "API key not valid" } }))
    const res = await chat(r, { user: "plan the migration", headers: { "x-session-affinity": "ses_i" } })
    eq(res.status, 200, "status")
    eq(res.headers.get("x-syrup-provider"), "opencode", "served by another provider")
    eq(mock.hits.filter((h) => h.provider === "google").length, 1, "no second google model tried with the rejected key")
    const ev = r.events.find((e) => e.providerId === "google")
    eq(ev.reason, "auth", "auth reason")
    const st = await r.status()
    assert(st.cooldowns.some((c) => c.scope === "k:google#k_google" && c.reason === "auth"), "key-scope cooldown")
    await chat(r, { user: "plan again", headers: { "x-session-affinity": "ses_i2" } })
    eq(mock.hits.filter((h) => h.provider === "google").length, 1, "google not called while the key cools")
  } finally {
    await r.close()
  }
})

await scenario("j) Groq free excluded for a 50K-token prompt, allowed for a tiny fast request", async () => {
  const r = await makeRouter({ keys: [K.groq] })
  try {
    const tiny = await chat(r, { alias: "fast", user: "title this chat" })
    eq(tiny.status, 200, "tiny status")
    eq(tiny.headers.get("x-syrup-provider"), "groq", "tiny served by groq")
    const hit = mock.of("groq/openai/gpt-oss-120b")[0]
    assert(hit.body.max_tokens <= 8000, `groq max_tokens clamped under the TPM (${hit.body.max_tokens})`)
    const big = await chat(r, { user: "y".repeat(180_000) })
    eq(big.status, 400, "50K prompt rejected before any upstream call")
    eq(big.json?.error?.type, "syrup_request_too_large", "error type")
    eq(mock.of("groq/openai/gpt-oss-120b").length, 1, "groq not called for the big prompt")
  } finally {
    await r.close()
  }
  mock.reset()
  const r2 = await makeRouter({ keys: [K.groq, K.google] })
  try {
    const big = await chat(r2, { user: "z".repeat(180_000) })
    eq(big.status, 200, "big prompt served when another provider fits")
    eq(big.headers.get("x-syrup-provider"), "google", "served by google")
    eq(mock.of("groq/openai/gpt-oss-120b").length, 0, "groq skipped")
    const excluded = r2.received()[0].excluded
    eq(excluded.tpm, 1, "groq excluded for its tokens-per-minute limit")
  } finally {
    await r2.close()
  }
})

await scenario("k) max_tokens clamped to the model's limit.output", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    const res = await chat(r, { user: "add a README file", max_tokens: 64_000 })
    eq(res.status, 200, "status")
    const hit = mock.hits[0]
    const limit = CATALOG.get("opencode").get(hit.model).limit.output
    eq(hit.body.max_tokens, Math.min(64_000, limit), `max_tokens for ${hit.model}`)
    assert(hit.body.max_tokens < 64_000, "actually clamped")
    eq(hit.body.stream_options?.include_usage, true, "usage requested")
  } finally {
    await r.close()
  }
})

await scenario("l) fast + Google adds reasoning_effort low; nobody else gets it", async () => {
  const r = await makeRouter({ keys: [K.google] })
  try {
    const res = await chat(r, { alias: "fast", user: "title this chat" })
    eq(res.status, 200, "status")
    const hit = mock.hits[0]
    eq(hit.provider, "google", "google served")
    eq(hit.body.reasoning_effort, "low", "reasoning_effort")
    assert(hit.model !== "gemini-3.8-flash", "fast avoids the scarce flagship")
    await chat(r, { alias: "auto", user: "add a README file", headers: { "x-session-affinity": "ses_l_auto" } })
    eq(mock.hits[1].body.reasoning_effort, undefined, "auto sends no effort")
  } finally {
    await r.close()
  }
  const r2 = await makeRouter({ keys: [K.opencode] })
  try {
    await chat(r2, { alias: "fast", user: "title this chat" })
    eq(mock.hits.at(-1).body.reasoning_effort, undefined, "zen gets no effort")
  } finally {
    await r2.close()
  }
})

await scenario("m) client abort mid-stream aborts the upstream and records aborted", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", sseOk({ chunks: Array.from({ length: 60 }, (_, i) => `chunk${i} `), delayMs: 100 }))
    const ac = new AbortController()
    const res = await fetch(`${r.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "syrup/auto", messages: [{ role: "user", content: "add a README file" }], stream: true }),
      signal: ac.signal,
    })
    eq(res.status, 200, "committed")
    const reader = res.body.getReader()
    const first = await reader.read()
    assert(first.value && first.value.length > 0, "got a first chunk")
    ac.abort()
    await waitFor(() => mock.of("opencode/mimo-v2.6-flash-free")[0]?.closed, 3000, "upstream connection closed")
    await waitFor(() => r.events.some((e) => e.status === "aborted"), 3000, "aborted event")
    const ev = r.events.find((e) => e.status === "aborted")
    eq(ev.reason, "aborted", "aborted reason")
    eq(r.events.length, 1, "exactly one event")
  } finally {
    await r.close()
  }
})

await scenario("m2) a stream that closes after content with no finish reason is recorded as truncated, without a health penalty", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.once("opencode/mimo-v2.6-flash-free", sseOk({ chunks: ["half an ", "answer"], noFinish: true }))
    const h = { "x-session-affinity": "ses_m2" }
    const one = await chat(r, { user: "add a README file", headers: h })
    eq(one.status, 200, "committed")
    await waitFor(() => r.events.length === 1, 3000, "event recorded")
    eq(r.events[0].status, "error", "a cut-off answer is not recorded as ok")
    eq(r.events[0].reason, "truncated", "truncated reason")
    const two = await chat(r, { user: "add a README file", headers: h })
    eq(two.status, 200, "next step")
    eq(mock.hits.at(-1).key, "opencode/mimo-v2.6-flash-free", "same backend still serves: no cooldown from a missing finish reason")
  } finally {
    await r.close()
  }
})

await scenario("n) interleaved reasoning_content restored on a later turn (Kimi K3)", async () => {
  const r = await makeRouter({ keys: [K.nvidia] })
  try {
    mock.once("nvidia/moonshotai/kimi-k3", sseOk({ text: "", chunks: [], reasoning: "I should read package.json first", toolCall: "call_k1" }))
    const h = { "x-session-affinity": "ses_n" }
    const one = await chat(r, { user: "what does this repo do", headers: h })
    eq(one.status, 200, "turn 1")
    const turn2 = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "what does this repo do" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_k1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_k1", content: '{"name":"demo"}' },
      { role: "assistant", content: "", tool_calls: [{ id: "call_other", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_other", content: "ok" },
    ]
    const two = await chat(r, { messages: turn2, headers: h })
    eq(two.status, 200, "turn 2")
    const sent = mock.hits[1].body.messages
    eq(sent[2].reasoning_content, "I should read package.json first", "reasoning restored on the known tool call")
    eq(sent[4].reasoning_content, "", "unknown tool call gets an empty field")
    eq(sent[3].reasoning_content, undefined, "tool messages untouched")
  } finally {
    await r.close()
  }
})

await scenario("o) everything cooling → 429 with retry-after", async () => {
  const r = await makeRouter({ keys: [K.google] })
  try {
    mock.set("google/gemini-3.8-flash", status(429, GOOGLE_PER_DAY))
    mock.set("google/gemini-3.5-flash-lite", status(429, GOOGLE_PER_DAY))
    const res = await chat(r, { user: "add a README file" })
    eq(res.status, 429, "status after all attempts")
    const ra = Number(res.headers.get("retry-after"))
    assert(ra > 0 && ra <= 25 * 3600, `retry-after set (${ra})`)
    eq(res.json?.error?.type, "syrup_all_cooling_down", "error type")
    const hits = mock.hits.length
    const again = await chat(r, { user: "add a README file" })
    eq(again.status, 429, "second request answered from cooldown state")
    assert(Number(again.headers.get("retry-after")) > 0, "retry-after on the second")
    eq(mock.hits.length, hits, "no upstream calls while everything cools")
  } finally {
    await r.close()
  }
})

await scenario("p) x-session-affinity defines the session, not message content", async () => {
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const h = { "x-session-affinity": "ses_p" }
    await chat(r, { user: "add a README file", headers: h })
    await chat(r, { messages: [{ role: "system", content: "Different prompt" }, { role: "user", content: "completely different request" }], headers: h })
    const ok = r.events.filter((e) => e.status === "ok")
    eq(ok[1].reason, "sticky", "sticky across different content")
    eq(ok[0].sessionId, "ses_p", "event carries the session id")
    eq(ok[1].providerId + ok[1].modelId, ok[0].providerId + ok[0].modelId, "same backend")
    // Without the header, different content means a different session.
    await chat(r, { user: "brand new chat about css" })
    eq(r.events.filter((e) => e.status === "ok")[2].sessionId, null, "no header → null session id")
  } finally {
    await r.close()
  }
})

await scenario("q) OpenCode Zen is never a production backend (its free tier refuses proxied requests)", async () => {
  assert(!("opencode" in R.BASE_URL), "BASE_URL must not route opencode")
  assert("zai" in R.BASE_URL && "nvidia" in R.BASE_URL, "new providers are routable")
  eq(R.BASE_URL.anthropic, "https://api.anthropic.com/v1", "anthropic routes through its OpenAI-compatible endpoint")
  assert(!("cloudflare-workers-ai" in R.BASE_URL), "cloudflare needs an account id in the URL, so it is not routable")
})

await scenario("r) non-streaming requests work; all-400 passes the upstream body through", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    const res = await chat(r, { user: "add a README file", stream: false })
    eq(res.status, 200, "non-stream status")
    assert(res.json?.choices?.[0]?.message?.content?.startsWith("hello from opencode/"), "non-stream body")
    const bad = { error: { message: "Invalid value for 'tool_choice'", type: "invalid_request_error" } }
    for (const m of ["mimo-v2.6-flash-free", "big-pickle", "muse-spark-1.3-contributor-free"]) mock.set(`opencode/${m}`, status(400, bad))
    const res2 = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_r" } })
    eq(res2.status, 400, "400 passthrough")
    eq(res2.json?.error?.message, bad.error.message, "upstream body")
  } finally {
    await r.close()
  }
})

await scenario("s) /v1/models and /v1/status need the bearer; /health is open", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    const models = await (await fetch(`${r.url}/v1/models`, { headers: { authorization: `Bearer ${SECRET}` } })).json()
    eq(models.data.map((m) => m.id).join(","), "auto,fast", "aliases")
    eq((await fetch(`${r.url}/v1/status`)).status, 401, "status needs bearer")
    eq((await fetch(`${r.url}/health`)).status, 200, "health open")
    const st = await r.status()
    assert(Array.isArray(st.cooldowns) && typeof st.sessions === "number", "status snapshot shape")
  } finally {
    await r.close()
  }
})

// ------------------------------------------------------------------ review fixes

const GOOGLE_BAD_KEY = [
  {
    error: {
      code: 400,
      message: "API key not valid. Please pass a valid API key.",
      status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } }],
    },
  },
]

/** A 200 stream that ends (finish_reason, usage, [DONE]) without any content. */
function sseEmpty() {
  return async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    send({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })
    send({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    send({ id: "c", choices: [], usage: { prompt_tokens: 100, completion_tokens: 0 } })
    res.write("data: [DONE]\n\n")
    res.end()
  }
}

await scenario("unit: ordinary tool output is not a tool failure; real tool errors are", async () => {
  const s = { key: "x", sticky: null, stickyAt: 0, stickyByFallback: false, outEwma: 600, escalatedUntil: 0, lastSeen: 0 }
  // Two ordinary results in a row: a file read and a grep hit.
  const reads = [
    { role: "user", content: "add a readme" },
    ...toolTurn("c1", "export function f() { try { g() } catch (error) { log(error) } }"),
    ...toolTurn("c2", "src/a.ts:12: if (res.error) return"),
  ]
  eq(R.trailingToolFailures(reads), 0, "a read and a grep that mention errors")
  eq(R.difficulty("auto", reads, s, 1000).hard, false, "not a hard turn")
  eq(s.escalatedUntil, 0, "no escalation window")
  const ordinary = [
    "<file>\n00001| // Error: this comment mentions a failure\n00002| throw new Error('not found')\n</file>",
    "error.ts\nsrc/errors/index.ts",
    "Found 2 matches\nsrc/x.ts:\n  Line 3: ENOENT handling",
    "PASS src/errors.test.ts\n  ✓ reports a failed login (3 ms)",
  ]
  for (const text of ordinary) eq(R.trailingToolFailures([{ role: "user", content: "go" }, ...toolTurn("t", text), ...toolTurn("t2", text)]), 0, `ignores ${JSON.stringify(text.slice(0, 32))}`)
  const failures = [
    "Error: File not found: /repo/src/x.ts",
    "Error: oldString not found in content",
    "TypeError: Cannot read properties of undefined",
    "error[E0425]: cannot find value `x` in this scope",
    'Traceback (most recent call last):\n  File "a.py", line 1',
    "bash: pnpmx: command not found",
    "cat: missing.txt: No such file or directory",
    "fatal: not a git repository",
    "ENOENT: no such file or directory, open 'x'",
  ]
  for (const text of failures) eq(R.trailingToolFailures([{ role: "user", content: "go" }, ...toolTurn("t", text)]), 1, `counts ${JSON.stringify(text.slice(0, 32))}`)
})

await scenario("unit: Google's 400 API_KEY_INVALID is a rejected key; context wording is narrow", async () => {
  const now = Date.UTC(2026, 8, 27, 22, 0, 0)
  const base = { headers: {}, promptTokens: 20_000, now }
  const bad = R.classifyFailure({ ...base, status: 400, body: JSON.stringify(GOOGLE_BAD_KEY), providerID: "google" })
  eq(bad.reason, "auth", "google invalid key reason")
  eq(bad.scope, "key", "google invalid key cools the key")
  eq(bad.retryAt, now + 600_000, "10 min")
  const expired = [{ error: { code: 400, message: "API key expired. Please renew the API key.", status: "INVALID_ARGUMENT" } }]
  eq(R.classifyFailure({ ...base, status: 400, body: JSON.stringify(expired), providerID: "google" }).reason, "auth", "expired key")
  const notContext = [
    "Invalid 'messages[5].content': string too long. Expected a string with maximum length 10485760, but got a string with length 20000000 instead.",
    "Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 140 instead.",
    "Request exceeded the allowed number of images",
    "Input validation error: `max_new_tokens` must be <= 4096",
  ]
  for (const message of notContext) eq(R.classifyFailure({ ...base, status: 400, body: JSON.stringify({ error: { message } }), providerID: "openai" }).reason, "bad_request", `not an overflow: ${message.slice(0, 32)}`)
  const context = [
    "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens.",
    "The input token count (1234567) exceeds the maximum number of tokens allowed (1048576).",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length",
    "Please reduce the length of the messages or completion.",
    "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 131073. Given: 140000 `inputs` tokens and 2000 `max_new_tokens`",
  ]
  for (const message of context) eq(R.classifyFailure({ ...base, status: 400, body: JSON.stringify({ error: { message } }), providerID: "nvidia" }).reason, "context", `overflow: ${message.slice(0, 32)}`)
  const coded = { error: { message: "Your input exceeds the window of this model.", code: "context_length_exceeded" } }
  eq(R.classifyFailure({ ...base, status: 400, body: JSON.stringify(coded), providerID: "openai" }).reason, "context", "context_length_exceeded code")
})

await scenario("t) a rejected Google key (HTTP 400 API_KEY_INVALID) cools the whole key; another provider serves", async () => {
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    mock.set("google/gemini-3.8-flash", status(400, GOOGLE_BAD_KEY))
    mock.set("google/gemini-3.5-flash-lite", status(400, GOOGLE_BAD_KEY))
    const res = await chat(r, { user: "plan the migration", headers: { "x-session-affinity": "ses_t" } })
    eq(res.status, 200, "served")
    eq(res.headers.get("x-syrup-provider"), "opencode", "another provider served")
    eq(mock.hits.filter((h) => h.provider === "google").length, 1, "one google attempt, then the key is skipped")
    const ev = r.events.find((e) => e.providerId === "google")
    eq(ev.reason, "auth", "auth reason")
    eq(ev.httpStatus, 400, "upstream status kept")
    const st = await r.status()
    assert(st.cooldowns.some((c) => c.scope === "k:google#k_google" && c.reason === "auth"), "key-scope cooldown")
  } finally {
    await r.close()
  }
})

await scenario("u) an empty completion (finish reason, usage, [DONE], no content) fails over instead of committing", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", sseEmpty())
    const res = await chat(r, { user: "add a README file" })
    eq(res.status, 200, "status")
    const second = `${res.headers.get("x-syrup-provider")}/${res.headers.get("x-syrup-model")}`
    assert(second !== "opencode/mimo-v2.6-flash-free", "failed over")
    eq(res.content, `hello from ${second}`, "client sees only the second backend")
    const ev = r.events.find((e) => e.modelId === "mimo-v2.6-flash-free")
    eq(ev.reason, "empty", "empty reason")
    eq(ev.status, "error", "counted as an error, not ok")
    eq(ev.error, "finished (stop) without any content", "says why")
  } finally {
    await r.close()
  }
  mock.reset()
  const r2 = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", status(200, { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 0 } }))
    const res = await chat(r2, { user: "add a README file", stream: false })
    eq(res.status, 200, "non-stream status")
    assert(res.headers.get("x-syrup-model") !== "mimo-v2.6-flash-free", "non-stream empty answer failed over")
    eq(r2.events.find((e) => e.modelId === "mimo-v2.6-flash-free")?.reason, "empty", "non-stream empty reason")
  } finally {
    await r2.close()
  }
})

await scenario("v) a learned prompt cap expires after an hour", async () => {
  const clock = fakeClock()
  const r = await makeRouter({ keys: [K.opencode], now: clock.now })
  try {
    mock.once("opencode/mimo-v2.6-flash-free", status(400, { error: { message: "This model's maximum context length is 200000 tokens." } }))
    const big = `add a README file ${"x".repeat(40_000)}`
    eq((await chat(r, { user: big, headers: { "x-session-affinity": "ses_v1" } })).status, 200, "served by another model")
    eq(mock.of("opencode/mimo-v2.6-flash-free").length, 1, "mimo tried once")
    await chat(r, { user: big, headers: { "x-session-affinity": "ses_v2" } })
    eq(mock.of("opencode/mimo-v2.6-flash-free").length, 1, "same-size prompt skips mimo while the cap is fresh")
    clock.advance(61 * 60_000)
    const later = await chat(r, { user: big, headers: { "x-session-affinity": "ses_v3" } })
    eq(mock.of("opencode/mimo-v2.6-flash-free").length, 2, "an hour later mimo is tried again")
    eq(later.headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "and serves")
  } finally {
    await r.close()
  }
})

await scenario("w) catalog variants are not separate backends; api.id is the upstream name; OpenAI gets max_completion_tokens", async () => {
  const paid = { cost: { input: 5, output: 30 }, output: 128_000 }
  const catalog = new Map([
    [
      "openai",
      new Map([
        ["gpt-6-astra", M("gpt-6-astra", paid)],
        ["gpt-6-astra-fast", M("gpt-6-astra-fast", { ...paid, apiId: "gpt-6-astra", options: { serviceTier: "priority" }, cost: { input: 10, output: 60 } })],
        ["gpt-6-astra-pro", M("gpt-6-astra-pro", { ...paid, apiId: "gpt-6-astra", options: { reasoningMode: "pro" } })],
        ["astra-alias", M("astra-alias", { ...paid, apiId: "gpt-6-astra-2026-09-01" })],
      ]),
    ],
  ])
  const r = await makeRouter({ keys: [["openai", { id: "k_oai", secret: "oai-secret", tier: "paid" }]], catalog })
  try {
    mock.set("openai/gpt-6-astra", status(429, { error: { message: "Rate limit reached for requests" } }, { "retry-after": "20" }))
    const res = await chat(r, { user: "plan the rollout", headers: { "x-session-affinity": "ses_w" } })
    eq(res.status, 200, "served")
    const sent = mock.hits.map((h) => h.model)
    assert(!sent.includes("gpt-6-astra-fast") && !sent.includes("gpt-6-astra-pro"), `variant ids never sent upstream (${sent.join(", ")})`)
    eq(r.received()[0].candidates, 2, "variants are not candidates")
    eq(res.headers.get("x-syrup-model"), "astra-alias", "the renamed entry serves under its catalog id")
    eq(mock.hits.at(-1).model, "gpt-6-astra-2026-09-01", "and is called by its api.id")
    for (const h of mock.hits) {
      eq(h.body.max_tokens, undefined, `no max_tokens to OpenAI (${h.model})`)
      eq(h.body.max_completion_tokens, 32000, `max_completion_tokens carries the budget (${h.model})`)
    }
  } finally {
    await r.close()
  }
})

await scenario("w2) an Anthropic key routes through its OpenAI-compatible endpoint with an output budget on every request", async () => {
  const catalog = new Map([
    [
      "anthropic",
      new Map([
        ["claude-opus-5-5", M("claude-opus-5-5", { cost: { input: 4, output: 20 }, output: 128_000 })],
        ["claude-opus-5-5-fast", M("claude-opus-5-5-fast", { apiId: "claude-opus-5-5", options: { speed: "fast" }, cost: { input: 8, output: 40 }, output: 128_000 })],
      ]),
    ],
  ])
  const r = await makeRouter({ keys: [["anthropic", { id: "k_ant", secret: "ant-secret", tier: "paid" }]], catalog })
  try {
    const res = await chat(r, { user: "add a README file", extra: { max_tokens: undefined } })
    eq(res.status, 200, "served")
    const hit = mock.hits[0]
    eq(hit.provider, "anthropic", "anthropic endpoint")
    eq(hit.model, "claude-opus-5-5", "base model")
    eq(hit.headers.authorization, "Bearer ant-secret", "bearer key")
    eq(hit.body.max_tokens, 8192, "max_tokens always set for Anthropic")
    eq(r.received()[0].candidates, 1, "the fast variant is not a separate backend")
  } finally {
    await r.close()
  }
})

await scenario("w3) free first: a paid key never wins a routine turn over a good free model, and a paid failover returns to free", async () => {
  const clock = fakeClock()
  const catalog = new Map([
    ["nvidia", new Map([["moonshotai/kimi-k3", M("moonshotai/kimi-k3", { output: 131_072 })]])],
    ["anthropic", new Map([["claude-opus-5-5", M("claude-opus-5-5", { cost: { input: 4, output: 20 }, output: 128_000 })]])],
  ])
  const r = await makeRouter({ keys: [K.nvidia, ["anthropic", { id: "k_ant", secret: "ant-secret", tier: "paid" }]], catalog, now: clock.now })
  try {
    const h = { "x-session-affinity": "ses_w3" }
    const plain = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_w3_plain" } })
    eq(plain.headers.get("x-syrup-model"), "moonshotai/kimi-k3", "free kimi beats paid opus on a routine turn")
    mock.once("nvidia/moonshotai/kimi-k3", status(503, { error: { message: "The model is overloaded" } }))
    const one = await chat(r, { user: "add a README file", headers: h })
    eq(one.headers.get("x-syrup-model"), "claude-opus-5-5", "paid key only as a failover")
    clock.advance(60_000)
    const msgs = [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "add a README file" }, ...toolTurn("call_w3", "# demo")]
    const two = await chat(r, { messages: msgs, headers: h })
    eq(two.headers.get("x-syrup-model"), "moonshotai/kimi-k3", "back on the free backend at the next request")
    eq(r.received().at(-1).note, "released_paid", "released because the sticky backend costs money")
  } finally {
    await r.close()
  }
})

await scenario("w4) models the key does not serve (its GET /models) are never tried; an unusable list filters nothing", async () => {
  const catalog = new Map([
    [
      "nvidia",
      new Map([
        ["moonshotai/kimi-k3", M("moonshotai/kimi-k3", { output: 131_072 })],
        ["meta/llama-3.1-8b-instruct", M("meta/llama-3.1-8b-instruct", { context: 131_072, output: 16_384 })],
      ]),
    ],
  ])
  mock.serve("nvidia", ["meta/llama-3.1-8b-instruct", "some/other-model"])
  const r = await makeRouter({ keys: [K.nvidia], catalog })
  try {
    const res = await chat(r, { user: "add a README file" })
    eq(res.headers.get("x-syrup-model"), "meta/llama-3.1-8b-instruct", "kimi is not served by this key, so it is never tried")
    eq(mock.of("nvidia/moonshotai/kimi-k3").length, 0, "no request to the unserved model")
    eq(r.received()[0].unserved, 1, "logged as unserved")
  } finally {
    await r.close()
  }
  mock.reset()
  mock.serve("nvidia", ["totally/different-ids"])
  const r2 = await makeRouter({ keys: [K.nvidia], catalog })
  try {
    const res = await chat(r2, { user: "add a README file" })
    eq(res.headers.get("x-syrup-model"), "moonshotai/kimi-k3", "a list matching no catalog id is ignored")
  } finally {
    await r2.close()
  }
})

await scenario("w5) the engine's 'powered by syrup/auto' line is rewritten to the backend that answers", async () => {
  const r = await makeRouter({ keys: [K.nvidia] })
  try {
    const system = "You are syrup.\nYou are powered by the model named auto. The exact model ID is syrup/auto\n<env>…</env>"
    await chat(r, { messages: [{ role: "system", content: system }, { role: "user", content: "what are you" }] })
    const sent = mock.hits[0].body.messages[0].content
    assert(!sent.includes("syrup/auto"), "alias line replaced")
    assert(/model named .+\(NVIDIA\), picked by syrup's router\. The exact model ID is nvidia\//.test(sent), `names the real backend: ${sent}`)
  } finally {
    await r.close()
  }
})

await scenario("x) interleaved reasoning stays with its chat even when tool-call ids repeat across chats", async () => {
  const r = await makeRouter({ keys: [K.nvidia] })
  try {
    const id = "functions.read:0"
    mock.once("nvidia/moonshotai/kimi-k3", sseOk({ text: "", chunks: [], reasoning: "chat A plans to read the config", toolCall: id }))
    mock.once("nvidia/moonshotai/kimi-k3", sseOk({ text: "", chunks: [], reasoning: "chat B saw API_TOKEN=xyz in .env", toolCall: id }))
    await chat(r, { user: "what does this repo do", headers: { "x-session-affinity": "ses_xa" } })
    await chat(r, { user: "check my env file", headers: { "x-session-affinity": "ses_xb" } })
    const cont = (user) => [{ role: "system", content: "You are a coding agent." }, { role: "user", content: user }, ...toolTurn(id, "ok")]
    await chat(r, { messages: cont("what does this repo do"), headers: { "x-session-affinity": "ses_xa" } })
    eq(mock.hits.at(-1).body.messages[2].reasoning_content, "chat A plans to read the config", "chat A gets its own reasoning back")
    await chat(r, { messages: cont("something else"), headers: { "x-session-affinity": "ses_xc" } })
    eq(mock.hits.at(-1).body.messages[2].reasoning_content, "", "a chat that never saw the id gets none")
  } finally {
    await r.close()
  }
})

await scenario("y) a non-ASCII bearer as long as the secret gets 401 and the router keeps serving", async () => {
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on("unhandledRejection", onUnhandled)
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    const port = Number(new URL(r.url).port)
    const statusOf = (path, token) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { authorization: `Bearer ${token}` } }, (res) => {
          res.resume()
          res.on("end", () => resolve(res.statusCode))
        })
        req.setTimeout(2000, () => req.destroy(new AssertionError(`no response for ${path}`)))
        req.on("error", reject)
        req.end()
      })
    const token = "é".repeat(SECRET.length)
    eq(await statusOf("/v1/status", token), 401, "status endpoint")
    eq(await statusOf("/v1/models", token), 401, "models endpoint")
    await sleep(20)
    eq(unhandled.length, 0, "no unhandled rejection")
    eq((await chat(r, { user: "add a README file" })).status, 200, "router still serves")
  } finally {
    process.off("unhandledRejection", onUnhandled)
    await r.close()
  }
})

await scenario("z1) after a failover the session goes back to the better backend once it recovers", async () => {
  const clock = fakeClock()
  const catalog = new Map([
    [
      "nvidia",
      new Map([
        ["moonshotai/kimi-k3", M("moonshotai/kimi-k3", { output: 131_072 })],
        ["meta/llama-3.1-8b-instruct", M("meta/llama-3.1-8b-instruct", { context: 131_072, output: 16_384 })],
      ]),
    ],
  ])
  const r = await makeRouter({ keys: [K.nvidia], catalog, now: clock.now })
  try {
    const h = { "x-session-affinity": "ses_z1" }
    mock.once("nvidia/moonshotai/kimi-k3", status(503, { error: { message: "The model is overloaded" } }))
    const one = await chat(r, { user: "add a README file", headers: h })
    eq(one.headers.get("x-syrup-model"), "meta/llama-3.1-8b-instruct", "failover served turn 1")
    clock.advance(60_000)
    const msgs = [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "add a README file" }, ...toolTurn("call_z1", "# demo")]
    const two = await chat(r, { messages: msgs, headers: h })
    eq(two.headers.get("x-syrup-model"), "moonshotai/kimi-k3", "the next tool call goes back to the recovered backend")
    eq(r.received()[1].note, "released_fallback", "released because the session only landed there through failover")
    const three = await chat(r, { messages: [...msgs, ...toolTurn("call_z2", "ok")], headers: h })
    eq(three.headers.get("x-syrup-model"), "moonshotai/kimi-k3", "and stays there")
    eq(r.events.filter((e) => e.status === "ok").at(-1).reason, "sticky", "sticky again")
  } finally {
    await r.close()
  }
})

await scenario("z2) health penalties decay: a backend demoted by one failure wins new sessions again later", async () => {
  const clock = fakeClock()
  const catalog = new Map([
    [
      "nvidia",
      new Map([
        ["moonshotai/kimi-k3", M("moonshotai/kimi-k3", { output: 131_072 })],
        ["xiaomi/mimo-v2.6-pro", M("xiaomi/mimo-v2.6-pro", { output: 131_072 })],
      ]),
    ],
  ])
  const r = await makeRouter({ keys: [K.nvidia], catalog, now: clock.now })
  try {
    mock.once("nvidia/moonshotai/kimi-k3", status(503, { error: { message: "The model is overloaded" } }))
    const one = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_z2a" } })
    eq(one.headers.get("x-syrup-model"), "xiaomi/mimo-v2.6-pro", "failover")
    clock.advance(2 * 60_000)
    const two = await chat(r, { user: "rename a variable", headers: { "x-session-affinity": "ses_z2b" } })
    eq(two.headers.get("x-syrup-model"), "xiaomi/mimo-v2.6-pro", "shortly after, the failure still counts")
    clock.advance(40 * 60_000)
    const three = await chat(r, { user: "fix a typo", headers: { "x-session-affinity": "ses_z2c" } })
    eq(three.headers.get("x-syrup-model"), "moonshotai/kimi-k3", "once the penalty has decayed the better model wins again")
  } finally {
    await r.close()
  }
})

await scenario("z3) remaining-requests: 0 on a success is recorded as a cooldown event the status view can see", async () => {
  const r = await makeRouter({ keys: [K.groq] })
  try {
    mock.set("groq/openai/gpt-oss-120b", sseOk({ headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "6h" } }))
    const res = await chat(r, { alias: "fast", user: "title this chat" })
    eq(res.status, 200, "the answer itself is fine")
    await waitFor(() => r.events.length >= 2, 2000, "two events")
    const [ok, cool] = r.events
    eq(ok.status, "ok", "the answer is recorded first")
    eq(cool.status, "rate_limited", "then the exhaustion")
    eq(cool.reason, "rpd", "a 6 h reset reads as a daily budget")
    eq(cool.providerId + "/" + cool.modelId, "groq/openai/gpt-oss-120b", "same backend")
    assert(cool.ts > ok.ts, "the exhaustion row is the newest for this backend")
    const wait = cool.retryAt - cool.ts
    assert(wait > 5.9 * 3600_000 && wait <= 6 * 3600_000, `retryAt ≈ now + 6 h (${wait})`)
    const again = await chat(r, { alias: "fast", user: "title this chat" })
    eq(again.status, 429, "the router skips the exhausted backend")
    eq(mock.of("groq/openai/gpt-oss-120b").length, 1, "no second call")
  } finally {
    await r.close()
  }
})

await scenario("z4) sidecar key store refreshes keys from the app on a timer and right after a rejected key", async () => {
  const served = { status: 200, body: { google: { id: "k1", secret: "sk-OLD-1", tier: "free" } } }
  const gets = []
  const app = http.createServer(async (req, res) => {
    await readAll(req)
    if (req.method === "GET" && req.url.startsWith("/api/ingest/keys")) {
      gets.push({ url: req.url, auth: req.headers.authorization })
      res.writeHead(served.status, { "content-type": "application/json" })
      return res.end(JSON.stringify(served.body))
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  })
  await new Promise((r) => app.listen(0, "127.0.0.1", r))
  const cfg = (keys, ingestToken = "ingest-token") => ({ port: 0, secret: "s", keys, ingestUrl: `http://127.0.0.1:${app.address().port}`, ingestToken, engineUrl: "http://127.0.0.1:1", engineAuth: "Basic x" })
  const logs = []
  const log = (source, event, data, opts) => logs.push({ source, event, data, opts })
  try {
    const store = new R.HttpRouterStore(cfg(served.body), log, { keysRefreshMs: 100, authRefreshGapMs: 0 })
    eq((await store.activeKeys()).get("google").id, "k1", "starts with the SYRUP_KEYS keys")
    served.body = { google: { id: "k2", secret: "sk-NEW-2", tier: "free" }, nvidia: { id: "k3", secret: "nvapi-NEW-3", tier: "free" }, "cloudflare-workers-ai": { id: "k4", secret: "cf-4", tier: "free" } }
    await waitFor(() => logs.some((l) => l.event === "keys.refreshed"), 2000, "timer refresh")
    const keys = await store.activeKeys()
    eq(keys.get("google").id, "k2", "switched key picked up")
    eq(keys.get("nvidia").secret, "nvapi-NEW-3", "new provider picked up")
    assert(!keys.has("cloudflare-workers-ai"), "unroutable providers stay out")
    eq(gets[0].auth, "Bearer ingest-token", "authorised with the ingest token")
    assert(gets[0].url.includes("have=google"), `tells the app what it has (${gets[0].url})`)

    // Its own token, so the first store's timer cannot stand in for the refresh under test.
    const slow = new R.HttpRouterStore(cfg(served.body, "slow-token"), log, { keysRefreshMs: 60_000, authRefreshGapMs: 0 })
    const slowGets = () => gets.filter((g) => g.auth === "Bearer slow-token").length
    served.body = { google: { id: "k5", secret: "sk-NEWER-5", tier: "free" } }
    const event = { id: "e1", ts: Date.now(), alias: "auto", providerId: "google", modelId: "gemini-3.8-flash", keyId: "k2", tier: "free", status: "ok", httpStatus: 200, attempts: 1, latencyMs: 5, inputTokens: 0, outputTokens: 0, cost: 0, error: null, sessionId: null, ttftMs: 5, retryAt: null, reason: "best" }
    await slow.record(event)
    await sleep(50)
    eq(slowGets(), 0, "an ordinary event does not refresh")
    await slow.record({ ...event, id: "e2", status: "error", httpStatus: 401, error: "key rejected", ttftMs: null, reason: "auth" })
    await waitFor(() => slowGets() === 1, 2000, "refresh after a rejected key")
    for (let i = 0; i < 100 && (await slow.activeKeys()).get("google").id !== "k5"; i++) await sleep(20)
    eq((await slow.activeKeys()).get("google").id, "k5", "replaced key picked up without waiting for the timer")
    served.status = 500
    served.body = { error: "db down" }
    await slow.refreshKeys("interval")
    eq((await slow.activeKeys()).get("google").id, "k5", "a failed refresh keeps the current keys")
    assert(logs.some((l) => l.event === "keys.refresh_failed"), "failure logged")
    assert(!/sk-|nvapi-|cf-4/.test(JSON.stringify(logs)), "no key material in logs")
  } finally {
    app.closeAllConnections?.()
    app.close()
  }
})

await scenario("z5) a 403 about one model cools that model only; the key's other models still serve", async () => {
  // Google is the only key, so anything that answers proves the key was not benched.
  const r = await makeRouter({ keys: [K.google] })
  try {
    mock.set("google/gemini-3.8-flash", status(403, { error: { message: "gemini-3.8-flash is only available on the paid tier" } }))
    const res = await chat(r, { user: "plan the migration", headers: { "x-session-affinity": "ses_z5" } })
    eq(res.status, 200, "status")
    eq(res.headers.get("x-syrup-provider"), "google", "served by google on the same key")
    assert(res.headers.get("x-syrup-model") !== "gemini-3.8-flash", "by another model")
    const ev = r.events.find((e) => e.modelId === "gemini-3.8-flash")
    eq(ev.reason, "error", "not an auth failure")
    const st = await r.status()
    assert(st.cooldowns.some((c) => c.scope === "b:google/gemini-3.8-flash#k_google"), "the model itself cools")
    assert(!st.cooldowns.some((c) => c.scope.startsWith("k:google")), "the key does not cool")
    const again = await chat(r, { user: "plan another migration", headers: { "x-session-affinity": "ses_z5b" } })
    eq(again.status, 200, "second hard turn ok")
    eq(mock.of("google/gemini-3.8-flash").length, 1, "the refused model is not tried again")
  } finally {
    await r.close()
  }
})

await scenario("z6) a model that rejects the thinking parameter is retried plain at once, and stays plain", async () => {
  const r = await makeRouter({ keys: [K.google] })
  try {
    const probe = await chat(r, { alias: "fast", user: "title this chat", headers: { "x-session-affinity": "ses_z6_probe" } })
    eq(probe.status, 200, "probe status")
    const model = mock.hits[0].key
    eq(mock.hits[0].body.reasoning_effort, "low", "fast sends low effort to start with")
    mock.reset()
    mock.once(model, status(400, { error: { message: "Thinking level is not supported for this model.", code: 400, status: "INVALID_ARGUMENT" } }))
    const res = await chat(r, { alias: "fast", user: "title this chat too", headers: { "x-session-affinity": "ses_z6" } })
    eq(res.status, 200, "status")
    eq(res.headers.get("x-syrup-model"), model.split("/").slice(1).join("/"), "the same model answered")
    eq(mock.hits.length, 2, "exactly two upstream calls")
    eq(mock.hits[0].body.reasoning_effort, "low", "first call carried the parameter")
    eq(mock.hits[1].key, model, "second call went to the same model")
    eq(mock.hits[1].body.reasoning_effort, undefined, "second call went plain")
    const st = await r.status()
    assert(!st.cooldowns.some((c) => c.scope.includes(model.split("/")[1])), "no cooldown for a parameter the router caused")
    await chat(r, { alias: "fast", user: "and a third title", headers: { "x-session-affinity": "ses_z6c" } })
    eq(mock.hits.at(-1).key, model, "later fast requests still use it")
    eq(mock.hits.at(-1).body.reasoning_effort, undefined, "and never send the parameter again")
  } finally {
    await r.close()
  }
})

await scenario("z7) a retired model (404) is out for the day, with no health penalty", async () => {
  const clock = fakeClock()
  const r = await makeRouter({ keys: [K.google, K.opencode], now: clock.now })
  try {
    mock.set("google/gemini-3.8-flash", status(404, { error: { message: "This model models/gemini-3.8-flash is no longer available", code: 404, status: "NOT_FOUND" } }))
    const res = await chat(r, { user: "plan the migration", headers: { "x-session-affinity": "ses_z7" } })
    eq(res.status, 200, "status")
    assert(res.headers.get("x-syrup-model") !== "gemini-3.8-flash", "served by another model")
    const ev = r.events.find((e) => e.modelId === "gemini-3.8-flash")
    assert(ev.retryAt - ev.ts >= 23 * 3600_000, "cooldown lasts about a day")
    const hits = mock.of("google/gemini-3.8-flash").length
    clock.advance(2 * 3600_000)
    await chat(r, { user: "plan another migration", headers: { "x-session-affinity": "ses_z7b" } })
    eq(mock.of("google/gemini-3.8-flash").length, hits, "not tried again two hours later")
    const st = await r.status()
    const h = st.health.find((x) => x.id.includes("gemini-3.8-flash"))
    assert(!h || h.errRate < 0.1, "error rate untouched")
  } finally {
    await r.close()
  }
})

await scenario("z8) a chat's opening turn goes to the adequate model that answers fastest; later turns weigh quality again", async () => {
  const catalog = new Map([
    [
      "nvidia",
      new Map([
        ["moonshotai/kimi-k3", M("moonshotai/kimi-k3", { output: 131_072 })],
        ["xiaomi/mimo-v2.6-pro", M("xiaomi/mimo-v2.6-pro", { output: 131_072 })],
        ["meta/llama-3.1-8b-instruct", M("meta/llama-3.1-8b-instruct", { context: 131_072, output: 16_384 })],
      ]),
    ],
  ])
  // Deadlines long enough that a slow first token is measured, not timed out.
  const r = await makeRouter({ keys: [K.nvidia], catalog, timing: { ...TIMING, minDeadlineMs: 4500, maxDeadlineMs: 5000 } })
  try {
    // Teach the router that kimi is slow to its first token: two answers that take 3.5 s to start. Kimi outranks
    // mimo by ~11 quality points, so only a clear speed gap (~3 s predicted) may override it on an opening turn.
    for (let i = 0; i < 2; i++) {
      mock.once("nvidia/moonshotai/kimi-k3", sseOk({ firstDelayMs: 3500 }))
      const taught = await chat(r, { messages: continuation("warm up"), headers: { "x-session-affinity": `ses_z8_teach${i}` } })
      eq(taught.headers.get("x-syrup-model"), "moonshotai/kimi-k3", `teaching round ${i} used kimi`)
    }
    const opening = await chat(r, { user: "rename the variable", headers: { "x-session-affinity": "ses_z8_open" } })
    eq(opening.status, 200, "opening status")
    eq(opening.headers.get("x-syrup-model"), "xiaomi/mimo-v2.6-pro", "opening turn: the fast adequate model, not the slow strong one or the weak quick one")
    eq(opening.headers.get("x-syrup-reason"), "best", "ranked first, not reached through a hedge")
    const later = await chat(r, { messages: continuation("plan the migration"), headers: { "x-session-affinity": "ses_z8_later" } })
    eq(later.headers.get("x-syrup-model"), "moonshotai/kimi-k3", "a hard continuation weighs quality again")
    const rec = r.received()
    eq(rec.at(-2).opening, true, "opening logged")
    eq(rec.at(-1).opening, undefined, "continuation not logged as opening")
  } finally {
    await r.close()
  }
})

await scenario("z9) a fresh router seeds its memory from attempts another process recorded", async () => {
  const clock = fakeClock()
  const t = clock.now()
  const recent = [
    { id: "p1", ts: t - 60_000, alias: "auto", providerId: "google", modelId: "gemini-3.8-flash", keyId: "k_google", tier: "free", status: "error", httpStatus: 503, attempts: 1, latencyMs: 900, inputTokens: 0, outputTokens: 0, cost: 0, error: "overloaded (503)", sessionId: "s_old", ttftMs: null, retryAt: t + 120_000, reason: "overloaded" },
    { id: "p2", ts: t - 50_000, alias: "auto", providerId: "google", modelId: "gemini-3.5-flash-lite", keyId: "k_google", tier: "free", status: "ok", httpStatus: 200, attempts: 2, latencyMs: 4000, inputTokens: 16_000, outputTokens: 50, cost: 0, error: null, sessionId: "s_old", ttftMs: 3500, retryAt: null, reason: "fallback" },
  ]
  const events = []
  const store = { catalog: async () => CATALOG, activeKeys: async () => new Map([K.google]), record: async (e) => void events.push(e), recent: async () => recent }
  const router = R.createRouter({ store, log: () => {}, secret: SECRET, baseURLs, timing: TIMING, now: clock.now })
  const server = http.createServer((req, res) => void router.handle(req, res, new URL(req.url ?? "/", "http://localhost")))
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const st = await (await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${SECRET}` } })).json()
    assert(st.cooldowns.some((c) => c.scope === "b:google/gemini-3.8-flash#k_google" && c.reason === "overloaded"), "the other process's cooldown is in force here")
    const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-session-affinity": "ses_z9" }, body: JSON.stringify({ model: "syrup/auto", stream: true, messages: [{ role: "user", content: "plan the migration" }] }) })
    await res.text()
    eq(res.status, 200, "status")
    assert(res.headers.get("x-syrup-model") !== "gemini-3.8-flash", "the model that was overloaded a minute ago is not tried")
    eq(mock.hits.filter((h) => h.model === "gemini-3.8-flash").length, 0, "no request reached it")
    const st2 = await (await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${SECRET}` } })).json()
    const lite = st2.health.find((h) => h.id.includes("gemini-3.5-flash-lite"))
    assert(lite && lite.ttftMs > 2000, `the other process's slow first token is remembered (${lite?.ttftMs} ms)`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
})

await scenario("z10) opening turn: a silent first backend is hedged, and the first token wins", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
    const t0 = Date.now()
    const res = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_z10" } })
    eq(res.status, 200, "status")
    const winner = `${res.headers.get("x-syrup-provider")}/${res.headers.get("x-syrup-model")}`
    assert(winner !== "opencode/mimo-v2.6-flash-free", "the partner answered")
    eq(res.content, `hello from ${winner}`, "only the winner's content reached the client")
    eq(res.headers.get("x-syrup-reason"), "hedge", "answered by the hedge")
    assert(Date.now() - t0 < 1200, `answered before the first backend's deadline (${Date.now() - t0} ms)`)
    const lost = r.events.find((e) => e.modelId === "mimo-v2.6-flash-free")
    eq(lost.status, "aborted", "the cut attempt is recorded as aborted")
    eq(lost.reason, "hedged", "…because it lost the hedge")
    const st = await r.status()
    const mimo = st.health.find((h) => h.id.includes("mimo-v2.6-flash-free"))
    assert(!mimo || mimo.errRate < 0.1, "no error-rate penalty for losing a race")
    await waitFor(() => mock.of("opencode/mimo-v2.6-flash-free")[0]?.closed, 2000, "the cut upstream request was closed")
    // A continuation in the same chat is not hedged: one upstream call.
    mock.reset()
    const two = await chat(r, { messages: continuation("and a LICENSE"), headers: { "x-session-affinity": "ses_z10" } })
    eq(two.status, 200, "second turn ok")
    eq(mock.hits.length, 1, "no hedge on a continuation")
  } finally {
    await r.close()
  }
})

await scenario("z11) a hedge is not started when the first backend answers in time", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    const res = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_z11" } })
    eq(res.status, 200, "status")
    eq(mock.hits.length, 1, "one upstream call")
    eq(r.events.length, 1, "one event")
  } finally {
    await r.close()
  }
})

// ------------------------------------------------------------------ summary

mock.server.closeAllConnections?.()
mock.server.close()
const failedCount = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failedCount}/${results.length} scenarios passed`)
process.exit(failedCount ? 1 : 0)
