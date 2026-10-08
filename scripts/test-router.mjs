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
      'export { applySticky, difficulty, estimatePromptTokens, fallbackTitle, isTitleCall, trailingToolFailures } from "./src/server/router/policy"',
      'export { describeDrops, droppedAttempt } from "./src/lib/router-status"',
      'export { routerSwitch } from "./src/lib/router-answers"',
      'export { HttpRouterStore, parseKeyMeta, relayBaseURLs } from "./sidecar/store-http"',
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
  openrouterFree: ["openrouter", { id: "k_or", secret: "or-secret", tier: "free" }],
  openrouterPaid: ["openrouter", { id: "k_orp", secret: "orp-secret", tier: "paid" }],
  anthropicPaid: ["anthropic", { id: "k_ant", secret: "ant-secret", tier: "paid" }],
  zai: ["zai", { id: "k_zai", secret: "zai-secret", tier: "free" }],
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
const baseURLs = Object.fromEntries(["google", "opencode", "groq", "nvidia", "openrouter", "openai", "anthropic", "zai"].map((p) => [p, `${mock.url}/${p}`]))

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
/** Accepts the request and never answers: no status line, no headers. */
function hang() {
  return async (req, res) => {
    await new Promise((resolve) => res.on("close", resolve))
  }
}
/** Sends the status line and headers, then never sends the body. */
function headersThenHang(code, contentType) {
  return async (req, res) => {
    res.writeHead(code, { "content-type": contentType })
    res.write(" ")
    await new Promise((resolve) => res.on("close", resolve))
  }
}
/** Waits, then behaves like `fn`. */
function after(ms, fn) {
  return async (req, res, hit) => {
    await sleep(ms)
    if (hit.closed) return
    return fn(req, res, hit)
  }
}
/** An answer with no visible content that stops at its output cap: hidden thinking used up the budget (Gemini's documented empty output). */
function emptyAtCap() {
  return async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    send({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })
    send({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })
    send({ id: "c", choices: [], usage: { prompt_tokens: 600, completion_tokens: 512 } })
    res.write("data: [DONE]\n\n")
    res.end()
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
const TIMING = { minDeadlineMs: 800, maxDeadlineMs: 1500, lastDeadlineMs: 3000, budgetMs: 8000, idleMs: 2000, nonStreamMs: 5000, hedgeMinMs: 300, hedgeMaxMs: 400, leashMs: 500 }

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

/** OpenCode 1.18's title prompt (its hidden "title" agent, title.txt), opening lines plus filler to its real size (~2.1 KB). */
const TITLE_PROMPT = [
  "You are a title generator. You output ONLY a thread title. Nothing else.",
  "",
  "<task>",
  "Generate a brief title that would help the user find this conversation later.",
  "",
  "Follow all rules in <rules>",
  "Use the <examples> so you know what a good title looks like.",
  "Your output must be:",
  "- A single line",
  "- ≤50 characters",
  "- No explanations",
  "</task>",
].join("\n").padEnd(2096, "\n- Keep exact technical terms, numbers and filenames")

/** OpenCode's chat-title request (session/prompt.ts): the title prompt, the fixed ask, then the chat's first message, no tools. */
function titleCall(first = "add a README file") {
  return [
    { role: "system", content: TITLE_PROMPT },
    { role: "user", content: "Generate a title for this conversation:\n" },
    { role: "user", content: first },
  ]
}

/**
 * A title the router let go: a normal 200 completion (never an error, which would leave OpenCode's timestamp title for
 * good) whose text is the router's own title made from the first message. Checks the exact wire shape OpenCode's AI SDK
 * parses: SSE chunks with role and content, a "stop" chunk, a usage chunk and [DONE]; or one chat.completion JSON.
 */
function syntheticTitle(res, expected, name = "title") {
  eq(res.status, 200, `${name}: a normal answer, not an error`)
  eq(res.headers.get("x-syrup-title"), "synthetic", `${name}: marked synthetic`)
  eq(res.headers.get("retry-after"), null, `${name}: nothing invites a retry`)
  if (res.json) {
    assert(/application\/json/.test(res.headers.get("content-type") ?? ""), `${name}: JSON for a non-streaming request`)
    eq(res.json.object, "chat.completion", `${name}: a chat.completion`)
    eq(res.json.choices?.[0]?.message?.role, "assistant", `${name}: from the assistant`)
    eq(res.json.choices[0].message.content, expected, `${name}: the title`)
    eq(res.json.choices[0].finish_reason, "stop", `${name}: finished`)
    assert(res.json.usage && res.json.usage.completion_tokens === 0, `${name}: usage, no tokens spent`)
    return
  }
  assert(/text\/event-stream/.test(res.headers.get("content-type") ?? ""), `${name}: SSE for a streaming request`)
  const data = res.text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
  eq(data.at(-1), "[DONE]", `${name}: ends with [DONE]`)
  const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
  assert(chunks.every((c) => c.object === "chat.completion.chunk" && typeof c.id === "string" && c.id === chunks[0].id), `${name}: chat.completion.chunk objects with one id`)
  eq(chunks[0].choices[0].delta.role, "assistant", `${name}: the first chunk names the role`)
  eq(res.content, expected, `${name}: the title`)
  eq(chunks.filter((c) => c.choices[0]?.finish_reason === "stop").length, 1, `${name}: one "stop"`)
  assert(chunks.at(-1).usage && chunks.at(-1).choices.length === 0, `${name}: a usage chunk last`)
}

/** An agent-sized system prompt of about `tokens` tokens (the router estimates ~3.6 characters per token). */
function agentSystem(tokens) {
  return { role: "system", content: `You are a coding agent.\n${"Use the tools to read and edit files. ".repeat(Math.ceil((tokens * 3.6) / 37))}` }
}

const READ_TOOL = { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }

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
  // A fresh session per judgment: a hard opening now escalates its session (decision 13), so a shared one would carry
  // the first verdict into the others. What follows a hard opening is covered by the escalation unit test.
  const fresh = () => ({ key: "x", sticky: null, stickyAt: 0, stickyByFallback: false, outEwma: 600, escalatedUntil: 0, lastSeen: 0 })
  const brief =
    "I'm working on a big project and need sample brands to test an image generator that is meant to be good at ads. " +
    "Help me create a whole campaign: one large document with prompts for image ads and video ads. Start with one product, " +
    "a new cereal inspired by a superhero series that just came out. Build the full brand around it, the product, the packaging, " +
    "the look and the voice, and give me very detailed prompts for each format so I can compare how the generator handles them. " +
    "Keep it to one product for now and we can add more brands later once this one works."
  const d = R.difficulty("auto", [{ role: "user", content: brief }], fresh(), 0)
  eq(d.hard, true, "a long, detailed creative brief is hard")
  assert(d.why?.startsWith("work:"), `why: ${d.why}`)
  eq(R.difficulty("auto", [{ role: "user", content: "write a haiku about rain" }], fresh(), 0).hard, false, "one work signal is routine")
  eq(R.difficulty("auto", [{ role: "user", content: "create a complete README for this repo" }], fresh(), 0).hard, true, "produce + depth is hard")
  const continuing = [{ role: "user", content: brief }, { role: "assistant", content: "Here is the campaign. # 1. Brand" }]
  eq(R.difficulty("auto", continuing, fresh(), 0).hard, true, "a continuation step keeps the turn's verdict")
  eq(R.difficulty("auto", [...continuing, { role: "user", content: "thanks!" }], fresh(), 0).hard, false, "the next user message is judged on its own")
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

await scenario("a) normal turn → non-scarce strong free model; a later plan/debug turn → gemini-3.8-flash", async () => {
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const normal = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_a1" } })
    eq(normal.status, 200, "normal status")
    const pick = `${normal.headers.get("x-syrup-provider")}/${normal.headers.get("x-syrup-model")}`
    assert(QUALITY_STRONG_FREE.has(pick), `normal turn picked ${pick}, wanted a strong keyless Zen model`)
    // Later turns: a hard opening is answered by a quick strong model first (decision 13, z12–z14).
    const planned = await chat(r, { messages: continuation("plan the architecture for the billing module"), headers: { "x-session-affinity": "ses_a2" } })
    eq(`${planned.headers.get("x-syrup-provider")}/${planned.headers.get("x-syrup-model")}`, "google/gemini-3.8-flash", "plan turn")
    const debug = await chat(r, { messages: continuation("debug the failing login test"), headers: { "x-session-affinity": "ses_a3" } })
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
    // The chat's real history, so this is a later hard turn: a one-message list would be a hard opening (decision 13).
    const three = await chat(r, { messages: [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "add a README file" }, { role: "assistant", content: "done" }, { role: "user", content: "now add a license" }, { role: "assistant", content: "done" }, { role: "user", content: "debug why the build fails" }], headers: h })
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

await scenario("e2) a failure the cloud relay marks as its own (x-syrup-relay-error) fails over with no cooldown and no health penalty; the provider's own 503 still cools", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    // The app could not read the key (database blip): every backend tried would have been marked overloaded before.
    mock.set("opencode/mimo-v2.6-flash-free", status(503, { error: { type: "syrup_relay_unavailable", message: "could not read your key, try again shortly" } }, { "x-syrup-relay-error": "unavailable", "retry-after": "2" }))
    const res = await chat(r, { user: "add a README file" })
    eq(res.status, 200, "client status")
    const [first] = r.events
    eq(first.reason, "relay", "recorded as the relay's own failure")
    eq(first.retryAt, null, "no cooldown")
    const st = await r.status()
    assert(!st.cooldowns.some((c) => c.backend?.includes("mimo") || JSON.stringify(c).includes("mimo")), `no cooldown on the backend (${JSON.stringify(st.cooldowns)})`)
  } finally {
    await r.close()
  }
  // A dead token: before, every key was cooled for 10 minutes as "rejected".
  const r2 = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", status(401, { error: { type: "syrup_relay_token", message: "this sandbox session has ended" } }, { "x-syrup-relay-error": "token" }))
    const res2 = await chat(r2, { user: "add a README file" })
    eq(res2.status, 200, "fails over")
    const tok = r2.events.find((e) => e.httpStatus === 401)
    eq(`${tok?.reason}/${tok?.retryAt}`, "relay/null", "not a rejected key, no cooldown")
  } finally {
    await r2.close()
  }
  // The provider's own 503 (no marker) is unchanged: overloaded, cooled.
  const r3 = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", status(503, { error: { message: "The model is overloaded" } }))
    await chat(r3, { user: "add a README file" })
    const own = r3.events.find((e) => e.httpStatus === 503)
    assert(own && own.reason === "overloaded" && own.retryAt, "the provider's own 503 still cools")
  } finally {
    await r3.close()
  }
  eq(R.describeDrops([{ status: "error", reason: "relay", modelId: "m" }], (m) => m), "m couldn't be reached by syrup. Trying another model…", "the waiting line does not blame the model")
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
    // A later hard turn, so the frontier Google model is tried first (a hard opening goes to a quick model, decision 13).
    const res = await chat(r, { messages: continuation("plan the migration"), headers: { "x-session-affinity": "ses_i" } })
    eq(res.status, 200, "status")
    eq(res.headers.get("x-syrup-provider"), "opencode", "served by another provider")
    eq(mock.hits.filter((h) => h.provider === "google").length, 1, "no second google model tried with the rejected key")
    const ev = r.events.find((e) => e.providerId === "google")
    eq(ev.reason, "auth", "auth reason")
    const st = await r.status()
    assert(st.cooldowns.some((c) => c.scope === "k:google#k_google" && c.reason === "auth"), "key-scope cooldown")
    await chat(r, { messages: continuation("plan again"), headers: { "x-session-affinity": "ses_i2" } })
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
    // A later hard turn, so the frontier Google model is tried first (a hard opening goes to a quick model, decision 13).
    const res = await chat(r, { messages: continuation("plan the migration"), headers: { "x-session-affinity": "ses_t" } })
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

await scenario("z4) sidecar key store holds key metadata only: refreshed on a timer and right after a rejected key, the ingest token as every secret", async () => {
  // The app's answer. A stray `secret` field (an old or buggy app) must never be taken up.
  const served = { status: 200, body: { keys: { google: { id: "k1", tier: "free" } } } }
  const gets = []
  const app = http.createServer(async (req, res) => {
    await readAll(req)
    if (req.method === "GET" && req.url.startsWith("/api/ingest/router/keys")) {
      gets.push({ url: req.url, auth: req.headers.authorization })
      res.writeHead(served.status, { "content-type": "application/json" })
      return res.end(JSON.stringify(served.body))
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  })
  await new Promise((r) => app.listen(0, "127.0.0.1", r))
  const cfg = (keyMeta, ingestToken = "ingest-token") => ({ port: 0, secret: "s", keyMeta, ingestUrl: `http://127.0.0.1:${app.address().port}`, ingestToken, engineUrl: "http://127.0.0.1:1", engineAuth: "Basic x", relayGzip: false })
  const logs = []
  const log = (source, event, data, opts) => logs.push({ source, event, data, opts })
  try {
    // SYRUP_ROUTER_KEYS parsing: well-formed entries only, and nothing but id and tier is kept.
    const parsed = R.parseKeyMeta({ google: { id: "k1", tier: "free", secret: "sk-SHOULD-DROP" }, nvidia: { id: "k3" }, groq: { id: "", tier: "paid" }, zai: "x" })
    eq(JSON.stringify(parsed), JSON.stringify({ google: { id: "k1", tier: "free" } }), "metadata parsed, secret dropped, malformed entries skipped")
    let threw = false
    try {
      R.parseKeyMeta([])
    } catch {
      threw = true
    }
    assert(threw, "a non-object is refused")

    const store = new R.HttpRouterStore(cfg(served.body.keys), log, { keysRefreshMs: 100, authRefreshGapMs: 0 })
    const first = (await store.activeKeys()).get("google")
    eq(first.id, "k1", "starts with the SYRUP_ROUTER_KEYS metadata")
    eq(first.secret, "ingest-token", "the secret the router sends is the ingest token")
    eq(store.keyId("google"), "k1", "keyId reads the metadata")
    eq(store.keyId("__proto__"), undefined, "keyId ignores inherited names")
    served.body = { keys: { google: { id: "k2", tier: "free", secret: "sk-NEW-2" }, nvidia: { id: "k3", tier: "paid" }, "cloudflare-workers-ai": { id: "k4", tier: "free" } } }
    await waitFor(() => logs.some((l) => l.event === "keys.refreshed"), 2000, "timer refresh")
    const keys = await store.activeKeys()
    eq(keys.get("google").id, "k2", "switched key picked up")
    eq(keys.get("nvidia").tier, "paid", "new provider and its tier picked up")
    assert([...keys.values()].every((k) => k.secret === "ingest-token"), "every secret is the ingest token, none from the app's answer")
    assert(!keys.has("cloudflare-workers-ai"), "unroutable providers stay out")
    eq(gets[0].auth, "Bearer ingest-token", "authorised with the ingest token")
    eq(gets[0].url, "/api/ingest/router/keys", "asks the metadata endpoint, with no query")

    // Its own token, so the first store's timer cannot stand in for the refresh under test.
    const slow = new R.HttpRouterStore(cfg(served.body.keys, "slow-token"), log, { keysRefreshMs: 60_000, authRefreshGapMs: 0 })
    const slowGets = () => gets.filter((g) => g.auth === "Bearer slow-token").length
    served.body = { keys: { google: { id: "k5", tier: "free" } } }
    const event = { id: "e1", ts: Date.now(), alias: "auto", providerId: "google", modelId: "gemini-3.8-flash", keyId: "k2", tier: "free", status: "ok", httpStatus: 200, attempts: 1, latencyMs: 5, inputTokens: 0, outputTokens: 0, cost: 0, error: null, sessionId: null, ttftMs: 5, retryAt: null, reason: "best" }
    await slow.record(event)
    await sleep(50)
    eq(slowGets(), 0, "an ordinary event does not refresh")
    await slow.record({ ...event, id: "e2", status: "error", httpStatus: 401, error: "key rejected", ttftMs: null, reason: "auth" })
    await waitFor(() => slowGets() === 1, 2000, "refresh after a rejected key")
    for (let i = 0; i < 100 && (await slow.activeKeys()).get("google").id !== "k5"; i++) await sleep(20)
    eq((await slow.activeKeys()).get("google").id, "k5", "replaced key picked up without waiting for the timer")
    assert(!(await slow.activeKeys()).has("nvidia"), "a removed provider drops out")
    await slow.refreshKeys("hint")
    eq(slowGets(), 2, "a key-id hint refreshes too")
    served.status = 500
    served.body = { error: "db down" }
    await slow.refreshKeys("interval")
    eq((await slow.activeKeys()).get("google").id, "k5", "a failed refresh keeps the current metadata")
    assert(logs.some((l) => l.event === "keys.refresh_failed"), "failure logged")
    served.status = 200
    served.body = { nope: true }
    await slow.refreshKeys("interval")
    eq((await slow.activeKeys()).get("google").id, "k5", "a malformed answer keeps the current metadata")
    assert(!/sk-|nvapi-|cf-4/.test(JSON.stringify(logs)), "no key material in logs")

    // Every provider's base URL is the app's relay.
    const urls = R.relayBaseURLs({ ingestUrl: "https://app.example" })
    eq(Object.keys(urls).sort().join(","), Object.keys(R.BASE_URL).sort().join(","), "one relay URL per routable provider")
    eq(urls.google, "https://app.example/api/ingest/llm/google", "relay URL shape")
    assert(Object.values(urls).every((u) => u.startsWith("https://app.example/api/ingest/llm/")), "no provider host left")
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
    // Later hard turns, so the frontier Google model is tried first (a hard opening goes to a quick model, decision 13).
    const res = await chat(r, { messages: continuation("plan the migration"), headers: { "x-session-affinity": "ses_z7" } })
    eq(res.status, 200, "status")
    assert(res.headers.get("x-syrup-model") !== "gemini-3.8-flash", "served by another model")
    const ev = r.events.find((e) => e.modelId === "gemini-3.8-flash")
    assert(ev.retryAt - ev.ts >= 23 * 3600_000, "cooldown lasts about a day")
    const hits = mock.of("google/gemini-3.8-flash").length
    clock.advance(2 * 3600_000)
    await chat(r, { messages: continuation("plan another migration"), headers: { "x-session-affinity": "ses_z7b" } })
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

// ------------------------------------------------------------------ round 1: hard turns answer fast, escalate after (decision 13)

await scenario("unit: a hard opening escalates its session through the user's next turn, however long the user takes; a routine opening or a hard later turn does not", async () => {
  const fresh = () => ({ key: "x", sticky: null, stickyAt: 0, stickyByFallback: false, outEwma: 600, escalatedUntil: 0, escalatedThroughUser: 0, lastSeen: 0 })
  const plan = [{ role: "user", content: "Plan the auth module" }]
  const reply = [...plan, { role: "assistant", content: "Here is the plan." }, { role: "user", content: "ok, do it" }]
  const s = fresh()
  eq(R.difficulty("auto", plan, s, 0).why, "keyword:plan", "the hard opening itself")
  eq(s.escalatedThroughUser, 2, "escalates its session through the next user turn (decision 13: the next turn, not a clock)")
  eq(s.escalatedUntil, 0, "no time window")
  eq(R.difficulty("auto", reply, s, 60_000).why, "escalated", "a routine-sounding reply is still hard")
  eq(R.difficulty("auto", reply, s, 11 * 60_000).why, "escalated", "even when the user read the plan for 11 minutes")
  eq(R.difficulty("auto", [...reply, ...toolTurn("c_e1", "ok")], s, 12 * 60_000).why, "escalated", "and so are that turn's own tool steps")
  const next = [...reply, { role: "assistant", content: "Done." }, { role: "user", content: "thanks" }]
  eq(R.difficulty("auto", next, s, 13 * 60_000).hard, false, "the user turn after the reply is judged on its own")
  eq(s.escalatedThroughUser, 0, "and ends the escalation")
  eq(R.difficulty("auto", reply, s, 14 * 60_000).hard, false, "a shorter history (a compaction) does not revive it")
  const routine = fresh()
  R.difficulty("auto", [{ role: "user", content: "add a readme" }], routine, 0)
  eq(routine.escalatedThroughUser + routine.escalatedUntil, 0, "a routine opening escalates nothing")
  const later = fresh()
  eq(R.difficulty("auto", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "plan the auth module" }], later, 0).hard, true, "a hard later turn is hard")
  eq(later.escalatedThroughUser + later.escalatedUntil, 0, "but escalates nothing: it is ranked quality-first from its first step, as before")
  const fast = fresh()
  R.difficulty("fast", plan, fast, 0)
  eq(fast.escalatedThroughUser + fast.escalatedUntil, 0, "Fast never escalates")
})

await scenario("z12) a hard opening is answered fast by a strong model: not the slow frontier one, not a weak quick one", async () => {
  const catalog = baseCatalog()
  catalog.set("nvidia", new Map([["meta/llama-3.1-8b-instruct", M("meta/llama-3.1-8b-instruct", { context: 131_072, output: 16_384 })]]))
  const r = await makeRouter({ keys: [K.google, K.opencode, K.nvidia], catalog })
  try {
    const res = await chat(r, { user: "plan the architecture for the billing module", headers: { "x-session-affinity": "ses_z12" } })
    eq(res.status, 200, "status")
    eq(`${res.headers.get("x-syrup-provider")}/${res.headers.get("x-syrup-model")}`, "opencode/mimo-v2.6-flash-free", "the quickest model of the strong grade answers")
    eq(res.headers.get("x-syrup-reason"), "best", "ranked first, not reached through a hedge")
    eq(mock.of("google/gemini-3.8-flash").length, 0, "the slow frontier model is not asked")
    eq(mock.of("nvidia/meta/llama-3.1-8b-instruct").length, 0, "nor the weak quick one")
    const rec = r.received()[0]
    eq(rec.opening, true, "logged as an opening")
    eq(rec.why, "keyword:plan", "logged as hard")
  } finally {
    await r.close()
  }
  mock.reset()
  // Google alone, with an agent-sized prompt (~12K tokens: the agent prompt and tool schemas), where the quick model's
  // head start outweighs its lower quality. Flash-Lite (quality 60) is below the strong grade: a hard opening goes to
  // the strong model, while a routine one still goes to the quick one.
  const r2 = await makeRouter({ keys: [K.google] })
  try {
    const agent = { role: "system", content: `You are a coding agent.\n${"Use the tools to read and edit files. ".repeat(1_200)}` }
    const hard = await chat(r2, { messages: [agent, { role: "user", content: "debug why the login test fails" }], headers: { "x-session-affinity": "ses_z12b" } })
    eq(hard.headers.get("x-syrup-model"), "gemini-3.8-flash", "hard opening: the strong floor keeps the quick mid model below")
    const routine = await chat(r2, { messages: [agent, { role: "user", content: "add a README file" }], headers: { "x-session-affinity": "ses_z12c" } })
    eq(routine.headers.get("x-syrup-model"), "gemini-3.5-flash-lite", "routine opening: unchanged")
  } finally {
    await r2.close()
  }
})

await scenario("z13) a hard opening is hedged too, by a partner that clears the routine floor; a weak model is never raced for one", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
    const t0 = Date.now()
    const res = await chat(r, { user: "plan the architecture for the billing module", headers: { "x-session-affinity": "ses_z13" } })
    eq(res.status, 200, "status")
    eq(res.headers.get("x-syrup-reason"), "hedge", "answered by the partner")
    eq(res.headers.get("x-syrup-model"), "big-pickle", "the next strong, free, non-scarce backend")
    assert(Date.now() - t0 < 1200, `answered before the first backend's deadline (${Date.now() - t0} ms)`)
    const lost = r.events.find((e) => e.modelId === "mimo-v2.6-flash-free")
    eq(lost.status, "aborted", "the silent one is cut")
    eq(lost.reason, "hedged", "as a lost race")
    eq(lost.retryAt, null, "with no cooldown")
  } finally {
    await r.close()
  }
  // The only other backend is weak: a hard opening does not race it (it stays a fallback); a routine opening still does.
  const catalog = new Map([
    ["opencode", new Map([["mimo-v2.6-flash-free", M("mimo-v2.6-flash-free", { context: 200_000, output: 32_000 })]])],
    ["nvidia", new Map([["meta/llama-3.1-8b-instruct", M("meta/llama-3.1-8b-instruct", { context: 131_072, output: 16_384 })]])],
  ])
  for (const [user, reason] of [
    ["plan the architecture for the billing module", "fallback"],
    ["add a README file", "hedge"],
  ]) {
    mock.reset()
    const r2 = await makeRouter({ keys: [K.opencode, K.nvidia], catalog })
    try {
      mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
      const res = await chat(r2, { user, headers: { "x-session-affinity": "ses_z13b" } })
      eq(res.headers.get("x-syrup-model"), "meta/llama-3.1-8b-instruct", `${user}: the weak model answers in the end`)
      eq(res.headers.get("x-syrup-reason"), reason, `${user}: ${reason === "hedge" ? "raced (routine: unchanged)" : "only after the deadline, never raced"}`)
      eq(r2.logs.some((l) => l.event === "hedge.start"), reason === "hedge", `${user}: hedge started`)
    } finally {
      await r2.close()
    }
  }
})

await scenario("z14) after a quick hard opening, the next request goes to the strongest grade: mid-turn, or on a routine-sounding reply", async () => {
  const sys = { role: "system", content: "You are a coding agent." }
  // A: the quick answer calls a tool, and the very next step is already the frontier model's.
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const h = { "x-session-affinity": "ses_z14a" }
    mock.once("opencode/mimo-v2.6-flash-free", sseOk({ text: "Let me run the test first.", toolCall: "call_z14" }))
    const ask = [sys, { role: "user", content: "debug why the login test fails" }]
    const one = await chat(r, { messages: ask, headers: h })
    eq(one.headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "the quick strong model answers first")
    const step = [...ask, ...toolTurn("call_z14", "FAIL login.test.ts: expected 200, got 401")]
    const two = await chat(r, { messages: step, headers: h })
    eq(two.headers.get("x-syrup-model"), "gemini-3.8-flash", "the next step is the frontier model's")
    eq(two.headers.get("x-syrup-reason"), "escalated", "escalated")
    const call = mock.hits.at(-1).body.messages[2].tool_calls[0]
    eq(call.extra_content?.google?.thought_signature, "skip_thought_signature_validator", "the quick model's tool call carries Google's documented skip value")
    const three = await chat(r, { messages: [...step, ...toolTurn("call_z14b", "export function login() {}")], headers: h })
    eq(three.headers.get("x-syrup-model"), "gemini-3.8-flash", "the rest of the turn stays there")
    eq(three.headers.get("x-syrup-reason"), "sticky", "sticky")
  } finally {
    await r.close()
  }
  mock.reset()
  // B: the quick answer ends the turn; the user's routine-sounding reply goes to the frontier model.
  const r2 = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const h = { "x-session-affinity": "ses_z14b" }
    const ask = [sys, { role: "user", content: "plan the billing module" }]
    eq((await chat(r2, { messages: ask, headers: h })).headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "quick first answer")
    const reply = await chat(r2, { messages: [...ask, { role: "assistant", content: "1. Model the invoices…" }, { role: "user", content: "ok, do it" }], headers: h })
    eq(reply.headers.get("x-syrup-model"), "gemini-3.8-flash", "the reply goes to the frontier model")
    eq(reply.headers.get("x-syrup-reason"), "escalated", "escalated")
    eq(r2.received().at(-1).why, "escalated", "because the session is escalated, not because of the reply's words")
  } finally {
    await r2.close()
  }
  mock.reset()
  // C: a chat that opened routine keeps today's rules: a hard later turn escalates, and the routine reply after it does not stay there.
  const r3 = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const h = { "x-session-affinity": "ses_z14c" }
    const open = [sys, { role: "user", content: "add a README file" }]
    eq((await chat(r3, { messages: open, headers: h })).headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "routine opening")
    const hardTurn = [...open, { role: "assistant", content: "Done." }, { role: "user", content: "debug the failing build" }]
    const hard = await chat(r3, { messages: hardTurn, headers: h })
    eq(hard.headers.get("x-syrup-model"), "gemini-3.8-flash", "a hard later turn goes to the frontier model at once")
    eq(hard.headers.get("x-syrup-reason"), "escalated", "escalated, as before")
    await chat(r3, { messages: [...hardTurn, { role: "assistant", content: "Fixed." }, { role: "user", content: "ok thanks" }], headers: h })
    eq(r3.received().at(-1).hard, false, "the reply after it is routine")
    eq(r3.received().at(-1).note, "released_scarce", "and leaves the scarce frontier model at the turn boundary, as before")
  } finally {
    await r3.close()
  }
})

// ------------------------------------------------------------------ round 1: a title is optional (decision 16)

await scenario("unit: title calls are recognised by OpenCode's two fixed texts; the waiting line skips lost hedges and let-go titles", async () => {
  eq(R.isTitleCall(titleCall(), undefined), true, "OpenCode's title call")
  eq(R.isTitleCall(titleCall(), []), true, "an empty tools list is no tools")
  eq(R.isTitleCall(titleCall(), [READ_TOOL]), false, "with tools it is not")
  const [system, ask, first] = titleCall()
  eq(R.isTitleCall([system, { role: "user", content: [{ type: "text", text: ask.content }] }, first], undefined), true, "the ask as a text part")
  eq(R.isTitleCall([{ role: "system", content: "You are a coding agent." }, ask, first], undefined), false, "another system prompt")
  eq(R.isTitleCall([system, { role: "user", content: "Generate a short 2-3 word name that describes this task:\nfix the bug" }], undefined), false, "another ask")
  eq(R.isTitleCall([ask, first], undefined), false, "the ask alone")
  eq(R.isTitleCall([{ role: "user", content: system.content }, ask, first], undefined), false, "the title prompt as a user message")
  eq(R.isTitleCall([system, { role: "assistant", content: ask.content }, first], undefined), false, "the ask as an assistant message")
  eq(R.isTitleCall([system, { role: "user", content: "Generate a title for this conversation: and then fix the bug" }, first], undefined), false, "the ask with more after it")
  eq(R.isTitleCall([{ role: "system", content: `You are a coding agent.\n${system.content}` }, ask, first], undefined), false, "the title prompt further down another system prompt")
  eq(R.droppedAttempt({ status: "timeout", reason: "timeout" }), true, "a timeout is a dropped model")
  eq(R.droppedAttempt({ status: "error", reason: null }), true, "so is an unexplained error")
  eq(R.droppedAttempt({ status: "aborted", reason: "hedged" }), false, "a lost race is not")
  eq(R.droppedAttempt({ status: "aborted", reason: "title_skipped" }), false, "a let-go title is not")
  eq(R.droppedAttempt({ status: "ok", reason: "best" }), false, "an answer is not")
})

await scenario("z15) a title call silent for its leash is let go at the leash with a title made from its first message: one backend, no cooldown, no penalty, no row in the chat", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
    const t0 = Date.now()
    const res = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z15" } })
    const took = Date.now() - t0
    syntheticTitle(res, "add a README file")
    assert(took >= TIMING.leashMs - 50 && took < TIMING.leashMs + 700, `let go at the leash (${took} ms)`)
    eq(mock.hits.length, 1, "no second backend is tried")
    await waitFor(() => mock.hits[0].closed, 2000, "the upstream request was closed")
    eq(r.events.length, 1, "one row")
    const ev = r.events[0]
    eq(ev.status, "aborted", "recorded as aborted")
    eq(ev.reason, "title_skipped", "because the title was let go")
    assert(/^synthetic title from the first message \(no first token within 0\.5s\)$/.test(ev.error ?? ""), `the row says the title was synthetic (${ev.error})`)
    eq(R.droppedAttempt(ev), false, "the waiting line does not call it a dropped model")
    eq(ev.retryAt, null, "no cooldown")
    eq(ev.sessionId, null, "kept out of the chat's rows")
    eq(r.logs.find((l) => l.event === "attempt.title_skipped")?.opts?.sessionId, "ses_z15", "the log keeps the session")
    const st = await r.status()
    assert(!st.cooldowns.some((c) => c.scope.includes("mimo")), "the backend is not cooling")
    const mimo = st.health.find((x) => x.id.includes("mimo-v2.6-flash-free"))
    assert(mimo && mimo.errRate < 0.1, "no error-rate penalty")
    eq(mimo.ttftMs, 2000, "a wait shorter than its first-token estimate (the prior) teaches nothing: it is only a lower bound")
    // The chat's own first turn is not hurt: the backend the title gave up on still serves it first.
    mock.reset()
    const turn = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_z15" } })
    eq(turn.headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "the next real turn still goes there")
  } finally {
    await r.close()
  }
  mock.reset()
  // A backend expected to answer well within the leash (Groq's prior: 350 ms) that stays silent past it: the wait
  // raises its first-token estimate, and still costs it no cooldown and no error rate.
  const r2 = await makeRouter({ keys: [K.groq] })
  try {
    mock.set("groq/openai/gpt-oss-120b", roleThenStall())
    syntheticTitle(await chat(r2, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z15b" } }), "add a README file", "let go")
    const st = await r2.status()
    const groq = st.health.find((x) => x.id.includes("gpt-oss-120b"))
    assert(groq && groq.ttftMs > 500, `the estimate rose to the lower bound's side (${groq?.ttftMs} ms)`)
    assert(groq.errRate < 0.1 && !st.cooldowns.length, "no error rate, no cooldown")
  } finally {
    await r2.close()
  }
})

await scenario("z16) only title calls are leashed: a Fast call with tools, a large or a small tool-less Fast call, and a title on Auto keep the normal deadlines and failover", async () => {
  const cases = [
    { name: "a title-shaped Fast call with tools", alias: "fast", messages: titleCall(), extra: { tools: [READ_TOOL] } },
    { name: "a large tool-less Fast call", alias: "fast", messages: [{ role: "system", content: "Summarize the text." }, { role: "user", content: "x ".repeat(20_000) }] },
    { name: "a small tool-less Fast call that is not a title", alias: "fast", messages: [{ role: "system", content: "You are a helpful AI assistant tasked with summarizing conversations." }, { role: "user", content: "Provide a detailed summary of our conversation above." }] },
    { name: "a title on Auto", alias: "auto", messages: titleCall() },
  ]
  for (const k of cases) {
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode] })
    try {
      mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
      const res = await chat(r, { alias: k.alias, messages: k.messages, extra: k.extra, headers: { "x-session-affinity": "ses_z16" } })
      eq(res.status, 200, `${k.name}: answered`)
      assert(mock.hits.length >= 2 && mock.hits[0].key === "opencode/mimo-v2.6-flash-free", `${k.name}: failed over (${mock.hits.map((x) => x.key).join(", ")})`)
      const ev = r.events.find((e) => e.modelId === "mimo-v2.6-flash-free")
      eq(ev.reason, "timeout", `${k.name}: an ordinary timeout`)
      assert(ev.retryAt !== null, `${k.name}: with its cooldown`)
      eq(r.events.find((e) => e.status === "ok")?.sessionId, "ses_z16", `${k.name}: rows keep the session`)
    } finally {
      await r.close()
    }
  }
})

await scenario("z17) a title whose one attempt fails is let go at once; a real failure keeps its cooldown, a cooled-out title gets the made-up title instead of a 429, and a refused thinking parameter is retried plain on the same backend", async () => {
  const r0 = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", status(503, { error: { message: "The model is overloaded" } }))
    const t0 = Date.now()
    const one = await chat(r0, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z17" } })
    syntheticTitle(one, "add a README file", "failed")
    assert(Date.now() - t0 < TIMING.leashMs, "at once, without waiting for the leash")
    eq(mock.hits.length, 1, "one attempt, though two other backends could take it")
    const ev = r0.events[0]
    eq(ev.reason, "overloaded", "a real overload")
    assert(ev.retryAt > ev.ts, "keeps its cooldown: the backend is overloaded for the chat's own turns too")
    eq(ev.sessionId, null, "kept out of the chat's rows")
  } finally {
    await r0.close()
  }
  mock.reset()
  const r = await makeRouter({ keys: [K.groq] })
  try {
    mock.set("groq/openai/gpt-oss-120b", status(503, { error: { message: "The model is overloaded" } }))
    syntheticTitle(await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z17a" } }), "add a README file", "the only backend fails")
    const two = await chat(r, { alias: "fast", messages: titleCall("rename the variable"), headers: { "x-session-affinity": "ses_z17b" } })
    syntheticTitle(two, "rename the variable", "everything cooling (not a 429)")
    eq(mock.hits.length, 1, "no upstream call")
  } finally {
    await r.close()
  }
  mock.reset()
  const r2 = await makeRouter({ keys: [K.google] })
  try {
    mock.once("google/gemini-3.5-flash-lite", status(400, { error: { message: "Thinking level is not supported for this model.", code: 400, status: "INVALID_ARGUMENT" } }))
    const res = await chat(r2, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z17c" } })
    eq(res.status, 200, "titled")
    eq(mock.hits.length, 2, "two calls")
    eq(mock.hits[1].key, mock.hits[0].key, "both to the same backend")
    eq(mock.hits[0].body.reasoning_effort, "minimal", "first with the thinking parameter (a title's least: minimal)")
    eq(mock.hits[1].body.reasoning_effort, undefined, "then plain")
  } finally {
    await r2.close()
  }
})

await scenario("z18) a title call that answers: its output is capped, its rows stay out of the chat, and a chat on Fast does not stick to the title's backend", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    const h = { "x-session-affinity": "ses_z18" }
    const res = await chat(r, { alias: "fast", messages: titleCall(), headers: h })
    eq(res.status, 200, "titled")
    eq(mock.hits.length, 1, "one call")
    eq(mock.hits[0].body.max_tokens, 512, "OpenCode's 32K output budget is capped for a title")
    eq(r.events.find((e) => e.status === "ok")?.sessionId, null, "the answer row is kept out of the chat too")
    eq(r.received()[0].title, true, "logged as a title call")
    // The chat itself is on Fast: its first step shares the title's session key and still gets a fresh pick.
    const step = await chat(r, { alias: "fast", user: "add a README file", headers: h, extra: { tools: [READ_TOOL] } })
    eq(step.status, 200, "the chat's step")
    const turn = r.events.filter((e) => e.status === "ok").at(-1)
    eq(turn.reason, "best", "picked on its own merits, not stuck to the title's backend")
    eq(turn.sessionId, "ses_z18", "the chat's own rows keep the session")
  } finally {
    await r.close()
  }
})

// ------------------------------------------------------------------ round 1 review: hard openings, escalation, hedges

/** A ranked entry for applySticky unit checks. */
function scoredOf(id, score, quality, grade, o = {}) {
  return { c: { id, info: { quality, grade }, scarce: false, costs: o.paid ? { input: 5, output: 25 } : null }, score, predMs: o.predMs ?? 5000, predTtftMs: 2000, outTokens: 1000, belowFloor: false }
}

await scenario("unit: escalation goes to the best-ranked model of the required grade, never sideways or down, and keeps it there; a paid key only where free first lets it win", async () => {
  const session = (sticky) => ({ key: "x", sticky, stickyAt: 0, stickyByFallback: false, outEwma: 600, escalatedUntil: 0, escalatedThroughUser: 0, lastSeen: 0 })
  // NVIDIA free on a 40K-token prompt: the quick strong model outranks the slower strong one, and the frontier one ranks last.
  const ranked = [scoredOf("deepseek-v4-flash", 70, 72, "strong"), scoredOf("mimo-v2.6-pro", 67, 82, "strong"), scoredOf("muse-spark-1.3", 65, 85, "frontier")]
  for (const why of ["escalated", "keyword:plan"]) {
    const shape = { alias: "auto", hard: true, hardWhy: why, lastIsUser: false }
    const up = R.applySticky(ranked, session("mimo-v2.6-pro"), shape)
    eq(up.ordered[0].c.id, "muse-spark-1.3", `${why}: the frontier model goes first, though it ranks last`)
    eq(up.reason, "escalated", `${why}: escalated`)
    eq(up.ordered.length, 3, `${why}: the others stay behind it as fallbacks`)
    const stay = R.applySticky(ranked, session("muse-spark-1.3"), shape)
    eq(stay.ordered[0].c.id, "muse-spark-1.3", `${why}: once there, it stays`)
    eq(stay.reason, "sticky", `${why}: sticky`)
  }
  // Only strong models on offer: a strong sticky one is not moved to a quicker strong one (a same-grade switch is not an escalation).
  const strongOnly = ranked.slice(0, 2)
  const kept = R.applySticky(strongOnly, session("mimo-v2.6-pro"), { alias: "auto", hard: true, hardWhy: "escalated", lastIsUser: false })
  eq(kept.ordered[0].c.id, "mimo-v2.6-pro", "no sideways move")
  eq(kept.reason, "sticky", "stays sticky")
  // A paid frontier model on offer next to free strong ones: a request hard only through escalation does not reach for it.
  const withPaid = [scoredOf("mimo-free", 64, 76, "strong"), scoredOf("opus-paid", 50, 92, "frontier", { paid: true })]
  const reply = R.applySticky(withPaid, session("mimo-free"), { alias: "auto", hard: true, hardWhy: "escalated", lastIsUser: true })
  eq(reply.ordered[0].c.id, "mimo-free", "escalated reply: the free strong model stays (free first)")
  eq(reply.reason, "sticky", "sticky")
  const ownHard = R.applySticky(withPaid, session("mimo-free"), { alias: "auto", hard: true, hardWhy: "keyword:debug", lastIsUser: true })
  eq(ownHard.ordered[0].c.id, "opus-paid", "a turn that is hard by its own words may still use the paid frontier key (no free 84+)")
  eq(ownHard.reason, "escalated", "escalated")
})

await scenario("z19) a hard opening's escalation lasts through the user's next turn, not ten minutes: a reply after eleven minutes still reaches the strong model", async () => {
  const clock = fakeClock()
  const r = await makeRouter({ keys: [K.google, K.opencode], now: clock.now })
  try {
    const h = { "x-session-affinity": "ses_z19" }
    const sys = { role: "system", content: "You are a coding agent." }
    const ask = [sys, { role: "user", content: "plan the billing module" }]
    eq((await chat(r, { messages: ask, headers: h })).headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "quick first answer")
    clock.advance(11 * 60_000)
    const replyMsgs = [...ask, { role: "assistant", content: "1. Model the invoices…" }, { role: "user", content: "ok, do it" }]
    const reply = await chat(r, { messages: replyMsgs, headers: h })
    eq(reply.headers.get("x-syrup-model"), "gemini-3.8-flash", "the reply, 11 minutes later, goes to the frontier model")
    eq(reply.headers.get("x-syrup-reason"), "escalated", "escalated")
    eq(r.received().at(-1).why, "escalated", "because the session is escalated")
    clock.advance(60_000)
    await chat(r, { messages: [...replyMsgs, { role: "assistant", content: "Done." }, { role: "user", content: "thanks" }], headers: h })
    eq(r.received().at(-1).hard, false, "the user turn after the reply is routine again")
  } finally {
    await r.close()
  }
})

await scenario("z20) free first after a hard opening: a paid frontier key gets nothing from the speed pick or the escalated reply; a turn hard by its own words may still use it", async () => {
  const catalog = new Map([
    [
      "opencode",
      new Map([
        ["mimo-v2.6-flash-free", M("mimo-v2.6-flash-free", { context: 200_000, output: 32_000 })],
        ["big-pickle", M("big-pickle", { context: 200_000, output: 32_000 })],
      ]),
    ],
    ["anthropic", new Map([["claude-opus-5", M("claude-opus-5", { cost: { input: 5, output: 25 }, output: 128_000 })]])],
  ])
  const r = await makeRouter({ keys: [K.opencode, K.anthropicPaid], catalog })
  try {
    const h = { "x-session-affinity": "ses_z20" }
    const paid = () => mock.of("anthropic/claude-opus-5").length
    const ask = [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "plan the billing module" }]
    const one = await chat(r, { messages: ask, headers: h })
    eq(one.headers.get("x-syrup-provider"), "opencode", "the hard opening is answered by a free strong model")
    eq(paid(), 0, "no paid request for the opening")
    const replyMsgs = [...ask, { role: "assistant", content: "1. Model the invoices…" }, { role: "user", content: "ok, do it" }]
    const reply = await chat(r, { messages: replyMsgs, headers: h })
    eq(r.received().at(-1).why, "escalated", "the reply is escalated")
    eq(reply.headers.get("x-syrup-model"), one.headers.get("x-syrup-model"), "and stays on the free strong model")
    eq(reply.headers.get("x-syrup-reason"), "sticky", "sticky")
    await chat(r, { messages: [...replyMsgs, ...toolTurn("call_z20", "ok")], headers: h })
    eq(paid(), 0, "nor for the reply or its steps")
    const hardMsgs = [...replyMsgs, ...toolTurn("call_z20", "ok"), { role: "assistant", content: "Done." }, { role: "user", content: "debug why the build fails" }]
    const hard = await chat(r, { messages: hardMsgs, headers: h })
    eq(hard.headers.get("x-syrup-model"), "claude-opus-5", "a turn hard by its own words: no free 84+, so the paid frontier model, as before")
    await chat(r, { messages: [...hardMsgs, { role: "assistant", content: "Fixed." }, { role: "user", content: "ok thanks" }], headers: h })
    eq(r.received().at(-1).note, "released_paid", "and the routine reply after it goes back to free")
  } finally {
    await r.close()
  }
})

await scenario("z21) a hard opening's speed pick never buys a paid model; a paid-only key set keeps the strong floor", async () => {
  const catalog = new Map([
    ["google", new Map([["gemini-3.7-flash", M("gemini-3.7-flash", { image: true, cost: { input: 0.5, output: 3 } })]])],
    ["openrouter", new Map([["deepseek/deepseek-v4-flash", M("deepseek/deepseek-v4-flash", { cost: { input: 0.3, output: 1.2 } })]])],
  ])
  const r = await makeRouter({ keys: [K.google, K.openrouterPaid], catalog })
  try {
    for (const tokens of [2_000, 16_000]) {
      const res = await chat(r, { messages: [agentSystem(tokens), { role: "user", content: "plan the billing module" }], headers: { "x-session-affinity": `ses_z21_${tokens}` } })
      eq(res.headers.get("x-syrup-model"), "gemini-3.7-flash", `${tokens} tokens: the free strong model, not the quicker, weaker paid one`)
    }
    eq(mock.of("openrouter/deepseek/deepseek-v4-flash").length, 0, "no paid request")
  } finally {
    await r.close()
  }
  mock.reset()
  const paidOnly = new Map([
    [
      "openrouter",
      new Map([
        ["openai/gpt-6-luna", M("openai/gpt-6-luna", { cost: { input: 0.5, output: 2 } })],
        ["openai/gpt-6-sol", M("openai/gpt-6-sol", { cost: { input: 1.25, output: 10 } })],
      ]),
    ],
  ])
  const r2 = await makeRouter({ keys: [K.openrouterPaid], catalog: paidOnly })
  try {
    // Routine first: an answer lowers the answering model's first-token estimate.
    const routine = await chat(r2, { messages: [agentSystem(12_000), { role: "user", content: "add a README file" }], headers: { "x-session-affinity": "ses_z21c" } })
    eq(routine.headers.get("x-syrup-model"), "openai/gpt-6-luna", "routine opening: the quick adequate one")
    const hard = await chat(r2, { messages: [agentSystem(12_000), { role: "user", content: "plan the billing module" }], headers: { "x-session-affinity": "ses_z21b" } })
    eq(hard.headers.get("x-syrup-model"), "openai/gpt-6-sol", "hard opening: the quick mid model stays below the strong floor (no free model sets it)")
  } finally {
    await r2.close()
  }
})

await scenario("z22) a hard opening with no free strong model keeps a quicker weak model below the quality-60 one", async () => {
  const catalog = new Map([
    ["google", new Map([["gemini-3.5-flash-lite", M("gemini-3.5-flash-lite", { image: true, cost: { input: 0.3, output: 2.5 } })]])],
    ["nvidia", new Map([["nvidia/nemotron-3.5-lightning", M("nvidia/nemotron-3.5-lightning", { context: 262_144, output: 32_768 })]])],
  ])
  const r = await makeRouter({ keys: [K.google, K.nvidia], catalog })
  try {
    const res = await chat(r, { messages: [agentSystem(12_000), { role: "user", content: "debug why the login test fails" }], headers: { "x-session-affinity": "ses_z22" } })
    eq(res.headers.get("x-syrup-model"), "gemini-3.5-flash-lite", "the quality-60 model, not the quicker quality-58 one")
  } finally {
    await r.close()
  }
})

await scenario("z23) a hard opening's partner below the first pick's floor waits until the pick is late: a strong pick on time is never pre-empted", async () => {
  const catalog = new Map([
    ["openrouter", new Map([["deepseek/deepseek-v4-flash:free", M("deepseek/deepseek-v4-flash:free", { context: 200_000, output: 32_000 })]])],
    ["google", new Map([["gemini-3.5-flash-lite", M("gemini-3.5-flash-lite", { image: true, cost: { input: 0.3, output: 2.5 } })]])],
  ])
  const user = "plan the architecture for the billing module"
  // On time: predicted ~0.9 s to its first token, it answers at 0.7 s. The routine 0.4 s hedge would have raced it.
  const r = await makeRouter({ keys: [K.openrouterFree, K.google], catalog })
  try {
    mock.set("openrouter/deepseek/deepseek-v4-flash:free", sseOk({ firstDelayMs: 700 }))
    const res = await chat(r, { user, headers: { "x-session-affinity": "ses_z23a" } })
    eq(res.headers.get("x-syrup-model"), "deepseek/deepseek-v4-flash:free", "the strong pick answers")
    eq(res.headers.get("x-syrup-reason"), "best", "not raced")
    eq(r.logs.some((l) => l.event === "hedge.start"), false, "no hedge started")
    eq(mock.of("google/gemini-3.5-flash-lite").length, 0, "the mid model was never asked")
  } finally {
    await r.close()
  }
  mock.reset()
  // Late: silent past 1.25× its prediction, so the quality-60 partner starts and answers.
  const r2 = await makeRouter({ keys: [K.openrouterFree, K.google], catalog })
  try {
    mock.set("openrouter/deepseek/deepseek-v4-flash:free", roleThenStall())
    const t0 = Date.now()
    const res = await chat(r2, { user, headers: { "x-session-affinity": "ses_z23b" } })
    const took = Date.now() - t0
    eq(res.headers.get("x-syrup-model"), "gemini-3.5-flash-lite", "the partner answers")
    eq(res.headers.get("x-syrup-reason"), "hedge", "as the hedge, before the first pick's deadline")
    const start = r2.logs.find((l) => l.event === "hedge.start")
    eq(start?.data.patient, true, "a patient hedge")
    assert(start.data.afterMs >= 1100, `started only once the pick was late (${start.data.afterMs} ms)`)
    assert(took < TIMING.maxDeadlineMs, `answered before the first pick's deadline (${took} ms)`)
  } finally {
    await r2.close()
  }
})

await scenario("z24) a hedged pair with nothing behind it: whichever is left gets the last candidate's deadline, so two slow but working backends answer", async () => {
  const catalog = new Map([
    [
      "opencode",
      new Map([
        ["mimo-v2.6-flash-free", M("mimo-v2.6-flash-free", { context: 200_000, output: 32_000 })],
        ["big-pickle", M("big-pickle", { context: 200_000, output: 32_000 })],
      ]),
    ],
  ])
  for (const user of ["plan the architecture for the billing module", "add a README file"]) {
    // Both start answering after 2 s, past the 1.5 s deadline of a backend with a fallback behind it.
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode], catalog })
    try {
      mock.set("opencode/mimo-v2.6-flash-free", sseOk({ firstDelayMs: 2000 }))
      mock.set("opencode/big-pickle", sseOk({ firstDelayMs: 2000 }))
      const res = await chat(r, { user, headers: { "x-session-affinity": "ses_z24a" } })
      eq(res.status, 200, `${user}: answered, not "all cooling down"`)
      eq(res.headers.get("x-syrup-model"), "big-pickle", `${user}: by the partner, which had the last candidate's deadline`)
      eq(res.headers.get("x-syrup-reason"), "hedge", `${user}: as the hedge`)
    } finally {
      await r.close()
    }
    // The partner fails at once: the first pick is now the last candidate, and its deadline is extended to match.
    mock.reset()
    const r2 = await makeRouter({ keys: [K.opencode], catalog })
    try {
      mock.set("opencode/mimo-v2.6-flash-free", sseOk({ firstDelayMs: 2000 }))
      mock.set("opencode/big-pickle", status(503, { error: { message: "The model is overloaded" } }))
      const res = await chat(r2, { user, headers: { "x-session-affinity": "ses_z24b" } })
      eq(res.status, 200, `${user}: answered`)
      eq(res.headers.get("x-syrup-model"), "mimo-v2.6-flash-free", `${user}: by the first pick, past its first deadline`)
      eq(mock.of("opencode/big-pickle").length, 1, `${user}: the partner was raced and failed`)
    } finally {
      await r2.close()
    }
  }
})

await scenario("z25) a hedge never sends a second request to a one-at-a-time key, and re-checks its partner when the race starts", async () => {
  const zai = new Map([
    [
      "zai",
      new Map([
        ["glm-5.3-flash", M("glm-5.3-flash", { context: 200_000, output: 32_000 })],
        ["glm-5.2", M("glm-5.2", { context: 200_000, output: 32_000 })],
      ]),
    ],
  ])
  for (const user of ["plan the architecture for the billing module", "add a README file"]) {
    mock.reset()
    const r = await makeRouter({ keys: [K.zai], catalog: zai })
    try {
      mock.set("zai/glm-5.3-flash", roleThenStall())
      const res = await chat(r, { user, headers: { "x-session-affinity": "ses_z25" } })
      eq(res.status, 200, `${user}: answered`)
      eq(res.headers.get("x-syrup-model"), "glm-5.2", `${user}: by the other model on the key`)
      eq(res.headers.get("x-syrup-reason"), "fallback", `${user}: only after the first one was let go, never alongside it`)
      eq(r.logs.some((l) => l.event === "hedge.start"), false, `${user}: no hedge`)
      const [first, second] = mock.hits
      assert(second.at - first.at >= TIMING.maxDeadlineMs - 100, `${user}: the second request waited for the first (${second.at - first.at} ms)`)
    } finally {
      await r.close()
    }
  }
  // With a backend on another key behind them, that one takes the race instead.
  mock.reset()
  const mixed = new Map([...zai, ["opencode", new Map([["big-pickle", M("big-pickle", { context: 200_000, output: 32_000 })]])]])
  const r1 = await makeRouter({ keys: [K.zai, K.opencode], catalog: mixed })
  try {
    mock.set("zai/glm-5.3-flash", roleThenStall())
    const res = await chat(r1, { user: "plan the architecture for the billing module", headers: { "x-session-affinity": "ses_z25m" } })
    assert(r1.received()[0].top[1]?.startsWith("zai/glm-5.2"), `the same key's other model ranks second (${r1.received()[0].top.join(" | ")})`)
    eq(res.headers.get("x-syrup-model"), "big-pickle", "the race goes to the backend on another key")
    eq(res.headers.get("x-syrup-reason"), "hedge", "as the hedge")
    eq(mock.of("zai/glm-5.2").length, 0, "nothing more is sent to the busy key")
  } finally {
    await r1.close()
  }
  // The partner was fine when the request was planned and starts cooling while the first pick is silent: no race.
  mock.reset()
  const catalog = new Map([
    ["opencode", new Map([["mimo-v2.6-flash-free", M("mimo-v2.6-flash-free", { context: 200_000, output: 32_000 })]])],
    ["nvidia", new Map([["z-ai/glm-5.2", M("z-ai/glm-5.2", { image: true, context: 200_000, output: 32_000 })]])],
  ])
  const r2 = await makeRouter({ keys: [K.opencode, K.nvidia], catalog })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", sseOk({ firstDelayMs: 1000 }))
    mock.once("nvidia/z-ai/glm-5.2", status(503, { error: { message: "The model is overloaded" } }))
    const opening = chat(r2, { user: "add a README file", headers: { "x-session-affinity": "ses_z25b" } })
    await sleep(100)
    // Another chat sends an image, which only glm-5.2 takes: its 503 cools glm-5.2 while the opening waits.
    const image = [{ type: "text", text: "what is in this picture" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]
    await chat(r2, { messages: [...continuation("hi").slice(0, 3), { role: "user", content: image }], headers: { "x-session-affinity": "ses_z25c" } })
    const res = await opening
    eq(res.headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "the first pick answers")
    eq(r2.logs.find((l) => l.event === "hedge.skipped")?.data.why, "cooling", "the race was called off: the partner is cooling now")
    eq(mock.of("nvidia/z-ai/glm-5.2").length, 1, "only the other chat's request reached glm-5.2")
  } finally {
    await r2.close()
  }
})

await scenario("z26) the hedge is a first-attempt, streaming-only race: a non-streaming opening and a second attempt are not raced", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", after(700, sseOk()))
    const res = await chat(r, { user: "add a README file", stream: false, headers: { "x-session-affinity": "ses_z26a" } })
    eq(res.status, 200, "answered")
    eq(mock.hits.length, 1, "one upstream call: a non-streaming request is not hedged")
  } finally {
    await r.close()
  }
  mock.reset()
  const catalog = new Map([
    [
      "opencode",
      new Map([
        ["mimo-v2.6-flash-free", M("mimo-v2.6-flash-free", { context: 200_000, output: 32_000 })],
        ["big-pickle", M("big-pickle", { context: 200_000, output: 32_000 })],
      ]),
    ],
    ["nvidia", new Map([["moonshotai/kimi-k3", M("moonshotai/kimi-k3", { output: 131_072 })]])],
  ])
  const r2 = await makeRouter({ keys: [K.opencode, K.nvidia], catalog })
  try {
    mock.set("nvidia/moonshotai/kimi-k3", status(503, { error: { message: "The model is overloaded" } }))
    mock.set("opencode/mimo-v2.6-flash-free", sseOk({ firstDelayMs: 700 }))
    const res = await chat(r2, { user: "add a README file", headers: { "x-session-affinity": "ses_z26b" } })
    eq(res.headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "the second attempt answers")
    eq(res.headers.get("x-syrup-reason"), "fallback", "as a fallback")
    eq(mock.of("opencode/big-pickle").length, 0, "the second attempt is not raced")
  } finally {
    await r2.close()
  }
})

await scenario("z27) a hard opening's race never spends scarce quota or money (decision 15), even when those rank second", async () => {
  const catalog = new Map([
    [
      "opencode",
      new Map([
        ["mimo-v2.6-flash-free", M("mimo-v2.6-flash-free", { context: 200_000, output: 32_000 })],
        ["big-pickle", M("big-pickle", { context: 200_000, output: 32_000 })],
      ]),
    ],
    ["openrouter", new Map([["deepseek/deepseek-v4-flash:free", M("deepseek/deepseek-v4-flash:free", { context: 200_000, output: 32_000 })]])],
  ])
  const r = await makeRouter({ keys: [K.opencode, K.openrouterFree], catalog })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
    const res = await chat(r, { messages: [agentSystem(12_000), { role: "user", content: "plan the architecture for the billing module" }], headers: { "x-session-affinity": "ses_z27" } })
    assert(r.received()[0].top[1]?.startsWith("openrouter/deepseek/deepseek-v4-flash:free"), `the scarce model ranks second (${r.received()[0].top.join(" | ")})`)
    eq(mock.of("openrouter/deepseek/deepseek-v4-flash:free").length, 0, "its 50-a-day quota is not spent on a race")
    eq(res.headers.get("x-syrup-reason"), "hedge", "the race goes to the next free, non-scarce model")
    eq(res.headers.get("x-syrup-model"), "big-pickle", "big-pickle")
  } finally {
    await r.close()
  }
  mock.reset()
  // No free model of quality 70+, so a paid key may answer a routine opening; it still never runs a race.
  const paid = new Map([
    [
      "openrouter",
      new Map([
        ["deepseek/deepseek-v4-flash", M("deepseek/deepseek-v4-flash", { cost: { input: 0.3, output: 1.2 } })],
        ["openai/gpt-6-luna", M("openai/gpt-6-luna", { cost: { input: 0.5, output: 2 } })],
      ]),
    ],
    ["google", new Map([["gemini-3.5-flash-lite", M("gemini-3.5-flash-lite", { image: true, cost: { input: 0.3, output: 2.5 } })]])],
  ])
  const r2 = await makeRouter({ keys: [K.openrouterPaid, K.google], catalog: paid })
  try {
    mock.set("openrouter/deepseek/deepseek-v4-flash", roleThenStall())
    const res = await chat(r2, { user: "add a README file", headers: { "x-session-affinity": "ses_z27b" } })
    assert(r2.received()[0].top[1]?.startsWith("openrouter/openai/gpt-6-luna"), `the paid model ranks second (${r2.received()[0].top.join(" | ")})`)
    eq(mock.of("openrouter/openai/gpt-6-luna").length, 0, "no money spent on a race")
    eq(res.headers.get("x-syrup-reason"), "hedge", "the race goes to the next free, non-scarce model")
    eq(res.headers.get("x-syrup-model"), "gemini-3.5-flash-lite", "Flash-Lite")
  } finally {
    await r2.close()
  }
})

await scenario("z28) a lost hedge teaches only a first-token lower bound: the loser's estimate and its overload streak stay", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
    const res = await chat(r, { user: "add a README file", headers: { "x-session-affinity": "ses_z28" } })
    eq(res.headers.get("x-syrup-reason"), "hedge", "hedged")
    const mimo = (await r.status()).health.find((x) => x.id.includes("mimo-v2.6-flash-free"))
    eq(mimo?.ttftMs, 2000, "a ~0.4 s wait under a 2 s estimate does not pull the estimate down")
  } finally {
    await r.close()
  }
  mock.reset()
  const clock = fakeClock()
  const catalog = new Map([
    ["opencode", new Map([["mimo-v2.6-flash-free", M("mimo-v2.6-flash-free", { context: 200_000, output: 32_000 })]])],
    ["nvidia", new Map([["meta/llama-3.1-8b-instruct", M("meta/llama-3.1-8b-instruct", { context: 131_072, output: 16_384 })]])],
  ])
  const r2 = await makeRouter({ keys: [K.opencode, K.nvidia], catalog, now: clock.now })
  try {
    const overloaded = status(503, { error: { message: "The model is overloaded" } })
    mock.once("opencode/mimo-v2.6-flash-free", overloaded)
    await chat(r2, { user: "add a README file", headers: { "x-session-affinity": "ses_z28a" } })
    const first = r2.events.find((e) => e.modelId === "mimo-v2.6-flash-free")
    assert(first.retryAt - first.ts > 29_000 && first.retryAt - first.ts <= 30_000, `first overload: 30 s (${first.retryAt - first.ts})`)
    clock.advance(31_000)
    mock.once("opencode/mimo-v2.6-flash-free", roleThenStall())
    eq((await chat(r2, { user: "add a README file", headers: { "x-session-affinity": "ses_z28b" } })).headers.get("x-syrup-reason"), "hedge", "mimo lost a race")
    mock.once("opencode/mimo-v2.6-flash-free", overloaded)
    await chat(r2, { user: "add a README file", headers: { "x-session-affinity": "ses_z28c" } })
    const second = r2.events.filter((e) => e.modelId === "mimo-v2.6-flash-free" && e.reason === "overloaded").at(-1)
    assert(second.retryAt - second.ts > 59_000, `the second overload of the spell backs off longer, as if the race never happened (${second.retryAt - second.ts})`)
  } finally {
    await r2.close()
  }
})

// ------------------------------------------------------------------ round 1 review: titles

await scenario("z29) a title is let go at its leash wherever its backend stalls: no headers, an error status or a JSON body that never arrives, keep-alives only", async () => {
  const cases = [
    { name: "no response headers", fn: hang(), stream: true },
    { name: "an error status whose body never arrives", fn: headersThenHang(503, "application/json"), stream: true },
    { name: "a JSON body that never arrives on a stream request", fn: headersThenHang(200, "application/json"), stream: true },
    { name: "a non-streaming body that never arrives", fn: headersThenHang(200, "application/json"), stream: false },
    { name: "keep-alive comments only", fn: keepAliveForever(), stream: true },
  ]
  for (const k of cases) {
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode] })
    try {
      mock.set("opencode/mimo-v2.6-flash-free", k.fn)
      const t0 = Date.now()
      const res = await chat(r, { alias: "fast", messages: titleCall(), stream: k.stream, headers: { "x-session-affinity": "ses_z29" } })
      const took = Date.now() - t0
      syntheticTitle(res, "add a README file", k.name)
      assert(took >= TIMING.leashMs - 50 && took < TIMING.leashMs + 700, `${k.name}: at the leash (${took} ms)`)
      eq(mock.hits.length, 1, `${k.name}: one backend`)
      eq(r.events.length, 1, `${k.name}: one row`)
      eq(r.events[0].status, "aborted", `${k.name}: aborted`)
      eq(r.events[0].reason, "title_skipped", `${k.name}: title_skipped`)
      eq(r.events[0].retryAt, null, `${k.name}: no cooldown`)
      eq(r.events[0].sessionId, null, `${k.name}: no session id`)
      eq((await r.status()).cooldowns.length, 0, `${k.name}: nothing cooling`)
    } finally {
      await r.close()
    }
  }
})

await scenario("z30) a title whose hidden thinking fills its output cap is let go like the leash, with no cooldown; Google titles ask for minimal thinking; anything else empty still fails over", async () => {
  const r = await makeRouter({ keys: [K.google] })
  try {
    mock.set("google/gemini-3.5-flash-lite", emptyAtCap())
    const res = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z30" } })
    syntheticTitle(res, "add a README file")
    assert(/^synthetic title from the first message \(.*output budget.*\)$/.test(r.events[0]?.error ?? ""), `the row says why (${r.events[0]?.error})`)
    eq(mock.hits.length, 1, "one backend")
    eq(mock.hits[0].body.reasoning_effort, "minimal", "a title asks Gemini for its least thinking")
    eq(mock.hits[0].body.max_tokens, 512, "within the title's output cap")
    eq(r.events[0].status, "aborted", "aborted")
    eq(r.events[0].reason, "title_skipped", "title_skipped")
    eq(r.events[0].retryAt, null, "no cooldown: the cap is the router's own")
    const st = await r.status()
    eq(st.cooldowns.length, 0, "nothing cooling")
    const lite = st.health.find((x) => x.id.includes("gemini-3.5-flash-lite"))
    assert(!lite || (lite.errRate < 0.1 && lite.ttftMs === 3000), `no error rate, no first-token lesson (${JSON.stringify(lite)})`)
    // The same empty answer on a chat step is a failure: it fails over and cools the backend.
    mock.reset()
    mock.set("google/gemini-3.5-flash-lite", emptyAtCap())
    const step = await chat(r, { alias: "fast", user: "add a README file", headers: { "x-session-affinity": "ses_z30b" }, extra: { tools: [READ_TOOL] } })
    eq(step.status, 200, "the chat step is answered")
    eq(mock.hits[0].body.reasoning_effort, "low", "a chat step on Fast keeps low effort")
    const ev = r.events.find((e) => e.modelId === "gemini-3.5-flash-lite" && e.reason === "empty")
    assert(ev && ev.retryAt !== null, "an empty chat step keeps its cooldown")
  } finally {
    await r.close()
  }
})

await scenario("z31) a title gets the made-up title when the catalog cannot load or no provider is connected; a chat request keeps its 503", async () => {
  const store = {
    catalog: async () => {
      throw new Error("catalog down")
    },
    activeKeys: async () => new Map([K.opencode]),
    record: async () => {},
  }
  const router = R.createRouter({ store, log: () => {}, secret: SECRET, baseURLs, timing: TIMING })
  const server = http.createServer((req, res) => void router.handle(req, res, new URL(req.url ?? "/", "http://localhost")))
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const down = { url: `http://127.0.0.1:${server.address().port}` }
  try {
    const t = await chat(down, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z31" } })
    syntheticTitle(t, "add a README file", "catalog down")
    eq((await chat(down, { user: "add a README file" })).status, 503, "catalog down: a chat request keeps its 503")
  } finally {
    server.closeAllConnections?.()
    await new Promise((res) => server.close(res))
  }
  const r = await makeRouter({ keys: [] })
  try {
    const t = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z31b" } })
    syntheticTitle(t, "add a README file", "no provider")
    eq((await chat(r, { user: "add a README file" })).status, 503, "no provider: a chat request keeps its 503")
  } finally {
    await r.close()
  }
})

await scenario("z32) a title's other rows stay out of the chat too: a used-up request budget, a hang-up mid-answer", async () => {
  const r = await makeRouter({ keys: [K.groq] })
  try {
    mock.set("groq/openai/gpt-oss-120b", sseOk({ headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "6h" } }))
    eq((await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z32" } })).status, 200, "titled")
    await waitFor(() => r.events.length >= 2, 2000, "two rows")
    eq(r.events[1].status, "rate_limited", "the budget row")
    eq(r.events[1].sessionId, null, "kept out of the chat")
  } finally {
    await r.close()
  }
  mock.reset()
  const r2 = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", sseOk({ chunks: Array.from({ length: 40 }, (_, i) => `t${i} `), delayMs: 100 }))
    const ac = new AbortController()
    const res = await fetch(`${r2.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-session-affinity": "ses_z32b" },
      body: JSON.stringify({ model: "syrup/fast", messages: titleCall(), stream: true, max_tokens: 32000 }),
      signal: ac.signal,
    })
    eq(res.status, 200, "committed")
    await res.body.getReader().read()
    ac.abort()
    await waitFor(() => r2.events.some((e) => e.status === "aborted"), 3000, "aborted row")
    eq(r2.events.find((e) => e.status === "aborted").sessionId, null, "kept out of the chat")
  } finally {
    await r2.close()
  }
})

await scenario("z33) every let-go title says why in the log, and the chat gets a title either way", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    mock.set("opencode/mimo-v2.6-flash-free", roleThenStall())
    syntheticTitle(await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z33a" } }), "add a README file", "leash")
    mock.reset()
    mock.set("opencode/mimo-v2.6-flash-free", status(503, { error: { message: "The model is overloaded" } }))
    syntheticTitle(await chat(r, { alias: "fast", messages: titleCall("x"), headers: { "x-session-affinity": "ses_z33b" } }), "x", "failed")
    const [leash, failed] = r.logs.filter((l) => l.event === "request.title_skipped").map((l) => l.data)
    assert(/no first token within 0\.5s/.test(leash?.why ?? ""), `the leash is named (${leash?.why})`)
    assert(/could not answer/.test(failed?.why ?? ""), `the failure is named (${failed?.why})`)
    eq(leash.synthetic, true, "logged as synthetic")
    eq(failed.title, "x", "with the title it got")
    eq(r.logs.find((l) => l.event === "request.title_skipped").opts?.sessionId, "ses_z33a", "the log keeps the session")
  } finally {
    await r.close()
  }
})

await scenario("z34) a title is ranked by first-token time (it writes ~50 tokens), and the plain retry after a refused thinking parameter shares its leash", async () => {
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const res = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z34" } })
    eq(res.headers.get("x-syrup-model"), "mimo-v2.6-flash-free", "the quicker first token wins over the faster decoder")
  } finally {
    await r.close()
  }
  mock.reset()
  const r2 = await makeRouter({ keys: [K.google] })
  try {
    mock.once("google/gemini-3.5-flash-lite", after(300, status(400, { error: { message: "Thinking level is not supported for this model.", code: 400, status: "INVALID_ARGUMENT" } })))
    mock.set("google/gemini-3.5-flash-lite", roleThenStall())
    const t0 = Date.now()
    const res = await chat(r2, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z34b" } })
    const took = Date.now() - t0
    syntheticTitle(res, "add a README file", "let go")
    eq(mock.hits.length, 2, "the refusal, then one plain try")
    assert(took < TIMING.leashMs + 250, `within one leash of the first attempt (${took} ms)`)
  } finally {
    await r2.close()
  }
})

// ------------------------------------------------------------------ round 1: a let-go title is made from the first message (decision 16, option e)

await scenario("unit: a let-go title is the first message's first line with text: markdown and code fences stripped, cut at a word boundary to 50 characters, never empty", async () => {
  const t = (first) => R.fallbackTitle(titleCall(first))
  eq(t("add a README file"), "add a README file", "a short message is the title as is")
  eq(t("Refactor the authentication middleware so that every route checks the session token before reading the body"), "Refactor the authentication middleware so that…", "a long one is cut at a word boundary, with an ellipsis")
  const fifty = "Make the sidebar collapse on phones under 400 wide"
  eq(fifty.length, 50, "fixture: exactly 50 characters")
  eq(t(fifty), fifty, "exactly 50 characters fits, with no ellipsis")
  eq(t(`${fifty.slice(0, 45)} please`), "Make the sidebar collapse on phones under 400…", "52 characters: cut before the last word")
  const url = `https://example.com/${"a".repeat(80)}`
  eq(t(url), `${url.slice(0, 49)}…`, "one word longer than the limit: a hard cut")
  eq(t("Fix the bug, then the next one, and the one after that please"), "Fix the bug, then the next one, and the one after…", "the 50th character is a space: cut right there")
  eq(t("Update the docs for the router and the policy, then rerun all tests"), "Update the docs for the router and the policy…", "no dangling comma before the ellipsis")
  for (const s of ["Refactor the authentication middleware so that every route checks", "x".repeat(200), "a ".repeat(100), "😀".repeat(60)]) {
    assert(Array.from(t(s)).length <= 50, `never over 50 characters (${t(s)})`)
  }
  eq(t("\n\n   \n  fix   the\tlogin   page  \nsecond line"), "fix the login page", "the first non-empty line, whitespace collapsed")
  eq(t("line one\r\nline two"), "line one", "Windows line ends")
  eq(t("## **Fix** the `parseConfig` bug in [config.ts](src/config.ts)\n\nmore"), "Fix the parseConfig bug in config.ts", "heading, bold, inline code and link stripped")
  eq(t("> - [ ] add *tests* for the _router_ ~~now~~"), "add tests for the router now", "quote, list, task box, emphasis and strikethrough stripped")
  eq(t("rename my_var_name to snake_case_name * 2"), "rename my_var_name to snake_case_name * 2", "snake_case and a lone asterisk survive")
  eq(t("---\n***\n\nwhat does this do?"), "what does this do?", "rules are not text")
  eq(t("![screenshot](data:image/png;base64,AAAA)\nwhy is this red"), "screenshot", "an image's alt text is text")
  eq(t("```ts\nconst x: number = 'a'\n```\nwhy does this not compile?"), "why does this not compile?", "a code block is skipped for the words after it")
  eq(t("~~~\nnpm ERR! code ERESOLVE\n~~~"), "npm ERR! code ERESOLVE", "a message that is only code gives the code's first line")
  eq(t("```\n\n```\n\nok"), "ok", "an empty code block")
  eq(t("```py\nprint(1)"), "print(1)", "an unclosed fence runs to the end")
  eq(t("<system-reminder>Plan mode is active.</system-reminder>\nadd a login page"), "add a login page", "OpenCode's system reminders are not the user's words")
  eq(t([{ type: "text", text: "  " }, { type: "text", text: "hello   world" }]), "hello world", "text parts")
  eq(t([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]), "New chat", "an image alone")
  eq(t([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "what is this" }]), "what is this", "an image with words")
  eq(t("   \n\t\n"), "New chat", "only whitespace")
  eq(t("```\n```"), "New chat", "only an empty code block")
  eq(t("---"), "New chat", "only markup")
  eq(R.fallbackTitle(titleCall().slice(0, 2)), "New chat", "no first message at all")
  // Review findings after the fallback landed.
  eq(t("What does __init__ do in my Python class?"), "What does __init__ do in my Python class?", "dunder names are not bold")
  eq(t("why is 2**10 not 2**10.0 in numpy"), "why is 2**10 not 2**10.0 in numpy", "a power operator is not bold")
  eq(t("this is **really** odd"), "this is really odd", "real bold is still stripped")
  eq(t("<think>why is my build failing</think>\nfix the build"), "fix the build", "a closed think block is not the title")
  eq(t("​​​"), "New chat", "only zero-width characters")
  eq(t("\u001b[31mred\u001b[0m alert\u0000"), "[31mred[0m alert", "control characters removed")
  eq(t("‮evil title"), "evil title", "a direction override removed")
  const family = "👨‍👩‍👧"
  const cut = t(`${"word ".repeat(9)}${family.repeat(10)}`)
  assert(!cut.includes("‍…") && !/‍$/.test(cut.replace("…", "")), `a cut never splits a family emoji (${cut})`)
  const synthetic = [
    { role: "system", content: "You are a title generator. You output ONLY a thread title. Nothing else." },
    { role: "user", content: "Generate a title for this conversation:\n" },
    { role: "user", content: "The following tool was executed by the user" },
    { role: "assistant", content: "" },
    { role: "user", content: "add dark mode to the settings page" },
  ]
  eq(R.fallbackTitle(synthetic), "add dark mode to the settings page", "OpenCode puts the first real message last, after synthetic turns")
})

await scenario("z35) at the real 4 s leash a silent title gets its made-up title at about 4 s, with no second backend though others could take it", async () => {
  const r = await makeRouter({ keys: [K.opencode], timing: { ...TIMING, leashMs: 4_000 } })
  try {
    for (const m of ["mimo-v2.6-flash-free", "big-pickle", "muse-spark-1.3-contributor-free"]) mock.set(`opencode/${m}`, roleThenStall())
    const t0 = Date.now()
    const res = await chat(r, { alias: "fast", messages: titleCall("Refactor the authentication middleware so that every route checks the session token before reading the body"), headers: { "x-session-affinity": "ses_z35" } })
    const took = Date.now() - t0
    syntheticTitle(res, "Refactor the authentication middleware so that…")
    assert(took >= 3_950 && took < 4_700, `at the leash, about 4 s (${took} ms)`)
    eq(mock.hits.length, 1, "one backend, no failover")
    eq(r.events.length, 1, "one row")
    eq(r.events[0].status, "aborted", "aborted: out of okRate, the alias pick and the answers")
    eq(r.events[0].reason, "title_skipped", "title_skipped: out of the waiting line")
    eq(r.events[0].error, "synthetic title from the first message (no first token within 4s)", "the row says the title was synthetic")
    eq(r.events[0].retryAt, null, "no cooldown")
  } finally {
    await r.close()
  }
})

await scenario("z36) a let-go title answers in the shape asked for: an image-only first message streams \"New chat\", a non-streaming request gets JSON with the markdown stripped; a title a model wrote is passed through untouched", async () => {
  const r = await makeRouter({ keys: [K.opencode] })
  try {
    for (const m of ["mimo-v2.6-flash-free", "big-pickle", "muse-spark-1.3-contributor-free"]) mock.set(`opencode/${m}`, roleThenStall())
    const image = await chat(r, { alias: "fast", messages: titleCall([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]), headers: { "x-session-affinity": "ses_z36a" } })
    syntheticTitle(image, "New chat", "image only")
    eq(mock.hits.length, 1, "image only: one backend")
    mock.reset()
    for (const m of ["mimo-v2.6-flash-free", "big-pickle", "muse-spark-1.3-contributor-free"]) mock.set(`opencode/${m}`, status(503, { error: { message: "The model is overloaded" } }))
    const t0 = Date.now()
    const plain = await chat(r, { alias: "fast", stream: false, messages: titleCall("```js\nfoo()\n```\n# Why does `foo()` throw **TypeError**?\nmore detail"), headers: { "x-session-affinity": "ses_z36b" } })
    syntheticTitle(plain, "Why does foo() throw TypeError?", "non-streaming")
    assert(Date.now() - t0 < TIMING.leashMs, "a failure answers at once")
    eq(plain.json.model, "syrup/fast", "names the model asked for")
    // A model that answers in time: its own title, not the router's.
    mock.reset()
    for (const m of ["mimo-v2.6-flash-free", "big-pickle", "muse-spark-1.3-contributor-free"]) mock.set(`opencode/${m}`, sseOk({ text: "README setup" }))
    const real = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z36c" } })
    eq(real.status, 200, "titled")
    eq(real.content, "README setup", "the model's title")
    eq(real.headers.get("x-syrup-title"), null, "not marked synthetic")
    assert(real.headers.get("x-syrup-model"), "from a model")
    eq(r.events.at(-1).status, "ok", "recorded as the model's answer")
  } finally {
    await r.close()
  }
})

// ------------------------------------------------------------------ round 1 review 2: a title commits on its title; a made-up title is cheap

/**
 * A model that streams its thinking as reasoning chunks (`field`: reasoning_content for big-pickle, mimo and kimi;
 * reasoning for groq's gpt-oss), `everyMs` apart, then optionally content, then `finish` ("length": the output cap).
 * `die`: the connection drops after the thinking. `stall`: silence after the thinking, until the router hangs up.
 */
function thinkThen({ field = "reasoning_content", thinking = "x".repeat(1300), everyMs = 0, content = [], finish = "length", die = false, stall = false } = {}) {
  return async (req, res, hit) => {
    if (!hit.body.stream) {
      res.writeHead(200, { "content-type": "application/json" })
      const message = { role: "assistant", [field]: thinking, ...(content.length ? { content: content.join("") } : {}) }
      res.end(JSON.stringify({ id: "cmpl", object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 600, completion_tokens: 512 } }))
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    send({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })
    for (const part of thinking.match(/.{1,40}/gs) ?? []) {
      if (hit.closed) return
      send({ id: "c", choices: [{ index: 0, delta: { [field]: part } }] })
      if (everyMs) await sleep(everyMs)
    }
    if (die) return void res.destroy()
    if (stall) return void (await new Promise((resolve) => res.on("close", resolve)))
    for (const part of content) send({ id: "c", choices: [{ index: 0, delta: { content: part } }] })
    send({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    send({ id: "c", choices: [], usage: { prompt_tokens: 600, completion_tokens: 512 } })
    res.write("data: [DONE]\n\n")
    res.end()
  }
}

await scenario("z37) a title that thinks out loud until its output cap gets the made-up title: reasoning_content (big-pickle), reasoning (gpt-oss), <think> in the text, whitespace, and non-streaming", async () => {
  const cases = [
    { name: "reasoning_content to the cap", key: K.opencode, model: "opencode/mimo-v2.6-flash-free", fn: thinkThen() },
    { name: "groq's reasoning field to the cap", key: K.groq, model: "groq/openai/gpt-oss-120b", fn: thinkThen({ field: "reasoning" }) },
    { name: "<think> in the text to the cap", key: K.opencode, model: "opencode/mimo-v2.6-flash-free", fn: thinkThen({ thinking: "", content: ["<think>", "let me see, a title for a README", " request..."] }) },
    { name: "thinking, then only whitespace, to the cap", key: K.opencode, model: "opencode/mimo-v2.6-flash-free", fn: thinkThen({ content: ["\n", "  "] }) },
    { name: "non-streaming, reasoning only, at the cap", key: K.opencode, model: "opencode/mimo-v2.6-flash-free", fn: thinkThen(), stream: false },
  ]
  for (const k of cases) {
    mock.reset()
    const r = await makeRouter({ keys: [k.key] })
    try {
      for (const m of ["mimo-v2.6-flash-free", "big-pickle", "muse-spark-1.3-contributor-free"]) mock.set(`opencode/${m}`, k.fn)
      mock.set("groq/openai/gpt-oss-120b", k.fn)
      const res = await chat(r, { alias: "fast", messages: titleCall(), stream: k.stream ?? true, headers: { "x-session-affinity": "ses_z37" } })
      syntheticTitle(res, "add a README file", k.name)
      eq(mock.hits.length, 1, `${k.name}: one backend`)
      eq(mock.hits[0].body.max_tokens, 512, `${k.name}: within the title's output cap`)
      eq(r.events.length, 1, `${k.name}: one row`)
      eq(r.events[0].status, "aborted", `${k.name}: aborted`)
      eq(r.events[0].reason, "title_skipped", `${k.name}: title_skipped`)
      assert(/^synthetic title from the first message \(.*output budget.*\)$/.test(r.events[0].error ?? ""), `${k.name}: the row says why (${r.events[0].error})`)
      eq((await r.status()).cooldowns.length, 0, `${k.name}: no cooldown, the cap is the router's own`)
    } finally {
      await r.close()
    }
  }
})

await scenario("z38) a title that thinks past its leash, or whose stream dies or stalls after thinking, gets the made-up title at once or at the leash; one that thinks then writes a title is passed through", async () => {
  const MIMO = "opencode/mimo-v2.6-flash-free"
  const all = (fn) => {
    for (const m of ["mimo-v2.6-flash-free", "big-pickle", "muse-spark-1.3-contributor-free"]) mock.set(`opencode/${m}`, fn)
  }
  // Thinking that never ends inside the leash: let go at the leash, named as thinking, with no first-token lesson.
  {
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode] })
    try {
      all(thinkThen({ thinking: "y".repeat(40 * 40), everyMs: 50 }))
      const t0 = Date.now()
      const res = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z38a" } })
      const took = Date.now() - t0
      syntheticTitle(res, "add a README file", "thinking past the leash")
      assert(took >= TIMING.leashMs - 50 && took < TIMING.leashMs + 700, `thinking past the leash: at the leash (${took} ms)`)
      eq(mock.hits.length, 1, "thinking past the leash: one backend")
      eq(r.events[0].reason, "title_skipped", "thinking past the leash: title_skipped")
      eq(r.events[0].error, "synthetic title from the first message (no title within 0.5s, the model was still thinking)", "thinking past the leash: the row says it was thinking")
      eq(r.logs.find((l) => l.event === "attempt.title_skipped")?.data?.why, "thinking", "thinking past the leash: logged as thinking")
      const h = (await r.status()).health.find((x) => x.id.includes(MIMO.split("/")[1]))
      assert(!h || h.ttftMs < 2_000, `thinking past the leash: no first-token lesson, its first token came in time (${JSON.stringify(h)})`)
    } finally {
      await r.close()
    }
  }
  // The stream dies after the thinking, before any title text.
  {
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode] })
    try {
      all(thinkThen({ die: true }))
      const t0 = Date.now()
      const res = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z38b" } })
      syntheticTitle(res, "add a README file", "dies after thinking")
      assert(Date.now() - t0 < TIMING.leashMs, "dies after thinking: answered at once")
      eq(mock.hits.length, 1, "dies after thinking: one backend")
    } finally {
      await r.close()
    }
  }
  // The stream stalls after the thinking: the leash still runs (no idle wait, which is longer).
  {
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode] })
    try {
      all(thinkThen({ stall: true }))
      const t0 = Date.now()
      const res = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z38c" } })
      const took = Date.now() - t0
      syntheticTitle(res, "add a README file", "stalls after thinking")
      assert(took < TIMING.leashMs + 700 && took < TIMING.idleMs, `stalls after thinking: at the leash, not the idle timeout (${took} ms)`)
    } finally {
      await r.close()
    }
  }
  // Thinking that stops ("stop") with no title: let go too (an empty answer, so it keeps its failure row).
  {
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode] })
    try {
      all(thinkThen({ finish: "stop" }))
      const res = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z38d" } })
      syntheticTitle(res, "add a README file", "stop after thinking")
      assert(/without a title, only thinking/.test(r.events[0]?.error ?? ""), `stop after thinking: the row says why (${r.events[0]?.error})`)
    } finally {
      await r.close()
    }
  }
  // Thinking, then a real title: the model's own, with its reasoning ahead of it, not marked synthetic.
  {
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode] })
    try {
      all(thinkThen({ thinking: "a README request", content: ["<think>more</think>", "README", " setup"], finish: "stop" }))
      const res = await chat(r, { alias: "fast", messages: titleCall(), headers: { "x-session-affinity": "ses_z38e" } })
      eq(res.status, 200, "thinks then writes: titled")
      eq(res.headers.get("x-syrup-title"), null, "thinks then writes: not synthetic")
      eq(res.content, "<think>more</think>README setup", "thinks then writes: the model's text, untouched")
      assert(res.text.includes('"reasoning_content":"a README request"'), "thinks then writes: its reasoning is passed through too")
      eq(r.events.at(-1).status, "ok", "thinks then writes: recorded as the model's answer")
    } finally {
      await r.close()
    }
  }
  // A chat step on Fast still commits on its first reasoning token (only a title waits for text).
  {
    mock.reset()
    const r = await makeRouter({ keys: [K.opencode] })
    try {
      all(thinkThen({ thinking: "z".repeat(40 * 40), everyMs: 50, content: ["done"], finish: "stop" }))
      const res = await chat(r, { alias: "fast", messages: continuation("summarise the file"), headers: { "x-session-affinity": "ses_z38f" }, extra: { tools: [READ_TOOL] } })
      eq(res.status, 200, "a chat step: answered")
      eq(res.content, "done", "a chat step: its answer")
      eq(mock.hits.length, 1, "a chat step: no deadline cut while it thinks")
    } finally {
      await r.close()
    }
  }
})

await scenario("unit: a made-up title is linear in the message: 1 MB adversarial lines and unclosed reminders return in milliseconds, long lines keep their start", async () => {
  const t = (first) => R.fallbackTitle(titleCall(first))
  // One long line must cost well under 50 ms (uncapped, a 200 KB one held the event loop for about a minute). A message
  // of up to a million short lines is one linear pass whose time is mostly allocation, so it gets room on a busy machine.
  // The best of three runs, so a garbage-collection pause in this busy test process is not blamed on the code.
  const timed = (name, first, expected, limitMs = 50) => {
    let ms = Infinity
    let got = ""
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      got = t(first)
      ms = Math.min(ms, performance.now() - t0)
    }
    assert(ms < limitMs, `${name}: under ${limitMs} ms (${ms.toFixed(1)} ms)`)
    if (expected !== undefined) eq(got, expected, `${name}: the title`)
    assert(Array.from(got).length <= 50 && got.length > 0, `${name}: a title of at most 50 characters (${got})`)
  }
  // Warm the regexes once so the first timing is not the compile.
  t("warm up **the** [regexes](x)")
  timed("unclosed bold, 1 MB", "**a ".repeat(250_000))
  timed("unclosed links, 1 MB", "[".repeat(1_000_000))
  timed("unclosed images, 1 MB", "![".repeat(500_000))
  timed("unclosed strikethrough, 1 MB", "~~a ".repeat(250_000))
  timed("python power operators, 1 MB", `y = x ${"**2 ".repeat(250_000)}`, "y = x **2 **2 **2 **2 **2 **2 **2 **2 **2 **2 **2…")
  timed("unclosed reminders, 1 MB", "<system-reminder>a".repeat(55_000))
  timed("many markup-only lines that strip to nothing, 1 MB", `${`![](x)${"**- ".repeat(250)}\n`.repeat(1_000)}the real question`, undefined, 250)
  timed("a million line breaks, then text", `${"\n".repeat(1_000_000)}finally a question`, "finally a question", 250)
  timed("half a million rules, then text", `${"-\n".repeat(500_000)}finally a question`, "finally a question", 250)
  timed("1 MB of one rule, then text", `${"-".repeat(1_000_000)}x\nfinally a question`)
  timed("1 MB of unclosed bold markup lines", `${"**- ".repeat(250)}\n`.repeat(1_000), "New chat", 250)
  timed("1 MB of one code line", `\`\`\`\n${"const a = 1; ".repeat(80_000)}\n\`\`\``)
  timed("a long line of leading spaces", `${" ".repeat(500_000)}indented words`, "indented words")
  eq(t(`${"a".repeat(999)}😀 tail`), `${"a".repeat(49)}…`, "a cut line never splits a surrogate pair")
  eq(t(`Fix [the login page](https://example.com/${"p".repeat(500)}) today`), "Fix the login page today", "a long link inside the cap is still stripped")
  eq(t("<system-reminder>one</system-reminder>\n<system-reminder>two</system-reminder>rename the file"), "rename the file", "several reminders")
  eq(t("<system-reminder>never closed\nadd tests"), "<system-reminder>never closed", "an unclosed reminder is left as it is")
})

await scenario("unit: a hedge win is a race, not a retry; the waiting line names only models that were dropped", async () => {
  const a = (o) => ({ ts: 10_000, alias: "auto", providerId: "opencode", modelId: "big-pickle", ttftMs: 400, latencyMs: 500, attempts: 1, reason: "best", ...o })
  eq(R.routerSwitch([a({ attempts: 2, reason: "hedge" })], [], 9_000), null, "a hedge winner gets no 'first pick couldn't answer' note")
  eq(R.routerSwitch([a({ attempts: 2, reason: "fallback" })], [], 9_000)?.kind, "retried", "a real fallback after a failure still does")
  const label = (id) => id.toUpperCase()
  const at = (o) => ({ ts: 1, alias: "auto", providerId: "x", modelId: "m", status: "aborted", reason: null, error: null, ...o })
  eq(R.describeDrops([at({ reason: "hedged" }), at({ reason: "title_skipped" }), at({ status: "ok", reason: "best" })], label), null, "a lost race, a let-go title and an answer drop nothing")
  eq(R.describeDrops([at({ reason: "hedged" }), at({ status: "timeout", reason: "timeout", modelId: "flash" })], label), "FLASH didn't answer in time. Trying another model…", "a timeout is named")
  eq(R.describeDrops([at({ status: "error", reason: "overloaded", modelId: "a" }), at({ status: "timeout", reason: "timeout", modelId: "b" })], label), "B didn't answer in time, 1 other before it. Trying another model…", "several")
})

// ------------------------------------------------------------------ eval traffic (docs/QUALITY.md §7 decision 4)

await scenario("eval1) x-syrup-eval keeps a hard turn off the scarce flagship; without it the same turn still takes it", async () => {
  const r = await makeRouter({ keys: [K.google, K.opencode] })
  try {
    const plan = () => continuation("plan the architecture for the billing module")
    const control = await chat(r, { messages: plan(), headers: { "x-session-affinity": "ses_eval1a" } })
    eq(control.headers.get("x-syrup-model"), "gemini-3.8-flash", "control: a hard turn picks the scarce flagship")
    mock.reset()
    const ev = await chat(r, { messages: plan(), headers: { "x-session-affinity": "ses_eval1b", "x-syrup-eval": "1" } })
    eq(ev.status, 200, "eval turn answered")
    eq(mock.of("google/gemini-3.8-flash").length, 0, "no request spent on the 20-a-day model")
    assert(ev.headers.get("x-syrup-model") !== "gemini-3.8-flash", "answered by a non-scarce model")
    const rec = r.received().at(-1)
    eq(rec.offScarce, true, "logged as eval traffic")
    assert(!rec.top.some((t) => t.startsWith("google/gemini-3.8-flash")), `scarce backends are not even fallbacks (${rec.top.join(" | ")})`)
    eq(r.received()[0].offScarce, undefined, "the control request is not eval traffic")
  } finally {
    await r.close()
  }
})

await scenario("eval2) eval traffic with only scarce backends left is refused at once (400, no retry-after), nothing spent", async () => {
  const catalog = new Map([["openrouter", new Map([["deepseek/deepseek-v4-flash:free", M("deepseek/deepseek-v4-flash:free", { context: 200_000, output: 32_000 })]])]])
  const r = await makeRouter({ keys: [K.openrouterFree], catalog })
  try {
    const res = await chat(r, { messages: continuation("add a README file"), headers: { "x-session-affinity": "ses_eval2", "x-syrup-eval": "1" } })
    eq(res.status, 400, "refused")
    eq(res.json?.error?.type, "syrup_scarce_only", "says why")
    eq(res.headers.get("retry-after"), null, "nothing invites a retry")
    eq(mock.hits.length, 0, "the account's 50-a-day quota is untouched")
    const plain = await chat(r, { messages: continuation("add a README file"), headers: { "x-session-affinity": "ses_eval2b" } })
    eq(plain.status, 200, "the same request without the header is answered as before")
  } finally {
    await r.close()
  }
})

await scenario("eval3) an eval title call with only scarce backends gets the router's own title, never an error", async () => {
  const catalog = new Map([["openrouter", new Map([["deepseek/deepseek-v4-flash:free", M("deepseek/deepseek-v4-flash:free", { context: 200_000, output: 32_000 })]])]])
  const r = await makeRouter({ keys: [K.openrouterFree], catalog })
  try {
    const res = await chat(r, { alias: "fast", messages: titleCall("convert the budget to PKR"), max_tokens: 32_000, headers: { "x-syrup-eval": "1" } })
    syntheticTitle(res, "convert the budget to PKR", "eval title")
    eq(mock.hits.length, 0, "no quota spent on a title")
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
