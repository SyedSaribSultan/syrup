#!/usr/bin/env node
/**
 * syrup cloud LLM relay test suite (/api/ingest/llm/<provider>/<path>).
 *
 * Bundles the relay logic (src/app/api/ingest/llm/relay.ts), the ingest token
 * code, the router core and the sidecar's store and fetch wrapper with esbuild,
 * then checks:
 * - the relay on its own, against a mock provider on 127.0.0.1: tokens, the
 *   route allow-list, header rules, unbuffered streaming, status pass-through,
 *   abort propagation (also through Next's own route pipeline), the deadline,
 *   key lookup failures, gzip bodies, the per-instance key cache, the spend
 *   policy, session-bound tokens, the sidecar's expected key id, marked
 *   app-side failures, and fitting an image-heavy body under the size cap;
 * - end to end: the sidecar's router → a mock syrup app serving the relay and
 *   the ingest ops → mock providers, including key switches and removals, a
 *   database outage and a dead token (no provider cooled), and image-heavy
 *   sessions over the cap;
 * - the bundled sidecar (same esbuild options as sidecar/build.mjs) as a child
 *   process with metadata-only env, reporting its bundle on /health;
 * - the added time to first byte of the hop on loopback: fresh, stale and miss.
 *
 *   node scripts/test-llm-proxy.mjs          (DEBUG=1 for logs)
 *
 * Exits non-zero when any scenario fails.
 */
import { build } from "esbuild"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import net from "node:net"
import path from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import zlib from "node:zlib"

const DEBUG = !!process.env.DEBUG
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "node_modules", ".cache", "syrup-llm-proxy-test")
mkdirSync(outDir, { recursive: true })

// The ingest token code reads the master key when it loads.
process.env.SYRUP_MASTER_KEY = crypto.randomBytes(32).toString("base64")

const outfile = path.join(outDir, "relay.mjs")
await build({
  stdin: {
    contents: [
      'export { createRelay, KeyCache, RELAY_ROUTES } from "./src/app/api/ingest/llm/relay"',
      'export { CatalogCache, catalogFromModelsDev, checkPolicy, UsageSniffer } from "./src/app/api/ingest/llm/policy"',
      'export { mintIngestToken, verifyIngestToken } from "./src/server/cloud/ingest"',
      'export { createRouter } from "./src/server/router/core"',
      'export { classifyFailure } from "./src/server/router/upstream-errors"',
      'export { estimatePromptTokens } from "./src/server/router/policy"',
      'export { BASE_URL } from "./src/server/router/backends"',
      'export { sidecarStale } from "./src/server/engine/sidecar-version"',
      'export { HttpRouterStore, relayBaseURLs } from "./sidecar/store-http"',
      'export { fitBody, IMAGE_DROPPED, relayFetch, parseServerTiming, RELAY_MAX_BODY_BYTES } from "./sidecar/relay-fetch"',
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
    sourcefile: "llm-proxy-test-entry.ts",
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
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

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
    if (await fn()) return
    await sleep(10)
  }
  throw new AssertionError(`timed out waiting for ${msg}`)
}
async function readAll(req) {
  const parts = []
  for await (const c of req) parts.push(c)
  return Buffer.concat(parts)
}
function json(buf) {
  try {
    return JSON.parse(Buffer.isBuffer(buf) ? buf.toString("utf8") : buf)
  } catch {
    return null
  }
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const results = []
async function scenario(name, fn) {
  const t0 = Date.now()
  prov.reset()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}: ${err instanceof AssertionError ? err.message : (err?.stack ?? err)}`)
  }
}

/** Real-looking provider secrets. None may ever reach the sandbox side, a log row or an error body. */
const SECRETS = { google: "AIzaREALgoogleKey00000001", google2: "AIzaREALgoogleKey00000002", nvidia: "nvapi-REALnvidiaKey000003", groq: "gsk_REALgroqKey0000000004", openrouter: "sk-or-REALopenrouter00005" }
const ALL_SECRETS = Object.values(SECRETS)
const leaked = (s) => ALL_SECRETS.filter((k) => String(s).includes(k))

const KEPT = [
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
const pick = (h) => Object.fromEntries(KEPT.filter((k) => h.get(k)).map((k) => [k, h.get(k)]))

// ------------------------------------------------------------------ mock provider

/** Normal OpenAI-style SSE answer. */
function sseOk(text) {
  return async (req, res, hit) => {
    const t = text ?? `hello from ${hit.provider}/${hit.body?.model}`
    if (hit.body && hit.body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: t }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    send({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })
    send({ id: "c", choices: [{ index: 0, delta: { content: t } }] })
    send({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    send({ id: "c", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })
    res.end("data: [DONE]\n\n")
  }
}
function status(code, body, headers = {}) {
  return async (req, res) => {
    res.writeHead(code, { "content-type": "application/json", ...headers })
    res.end(typeof body === "string" ? body : JSON.stringify(body))
  }
}
/** Never answers. */
function hang() {
  return (req, res) => new Promise((r) => res.on("close", r))
}
/** SSE content every `everyMs` until the client goes away; never finishes. */
function ticking(everyMs = 50) {
  return async (req, res, hit) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`)
    let n = 0
    while (!hit.closed) {
      res.write(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: `tick${n++} ` } }] })}\n\n`)
      await sleep(everyMs)
    }
  }
}

const prov = (() => {
  const hits = []
  const persistent = new Map()
  const queue = []
  const served = new Map()
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x")
    const provider = u.pathname.split("/")[1]
    const raw = await readAll(req)
    const hit = { provider, path: u.pathname, search: u.search, method: req.method, headers: req.headers, raw, body: json(raw), closed: false, closedAt: 0, at: performance.now() }
    hits.push(hit)
    res.on("close", () => {
      if (!res.writableFinished) {
        hit.closed = true
        hit.closedAt = performance.now()
      }
    })
    if (req.method === "GET" && u.pathname.endsWith("/models")) {
      const ids = served.get(provider)
      res.writeHead(ids ? 200 : 404, { "content-type": "application/json" })
      return res.end(JSON.stringify(ids ? { data: ids.map((id) => ({ id })) } : { error: "not found" }))
    }
    const behave = persistent.get(`${provider}:${u.pathname}`) ?? (queue.length ? queue.shift() : undefined) ?? persistent.get(provider) ?? persistent.get("*") ?? sseOk()
    try {
      await behave(req, res, hit)
    } catch (err) {
      if (DEBUG) console.log("mock provider error", err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  return {
    hits,
    server,
    url: "",
    /** Persistent behaviour for a provider ("*" for all), or for one exact path ("google:/google/chat/completions"). */
    set: (key, fn) => persistent.set(key, fn),
    /** Behaviour for the next chat request, whichever provider gets it. */
    next: (fn) => queue.push(fn),
    serve: (provider, ids) => served.set(provider, ids),
    chats: () => hits.filter((h) => h.method === "POST"),
    reset() {
      hits.length = 0
      persistent.clear()
      queue.length = 0
    },
  }
})()
await new Promise((r) => prov.server.listen(0, "127.0.0.1", r))
prov.url = `http://127.0.0.1:${prov.server.address().port}`
const PROVIDER_BASE = Object.fromEntries(["google", "nvidia", "groq", "openrouter", "fireworks-ai"].map((p) => [p, `${prov.url}/${p}`]))

// ------------------------------------------------------------------ keys (the app's database, mocked) + tokens

const db = {
  u1: {
    google: { id: "kg1", secret: SECRETS.google, tier: "free" },
    nvidia: { id: "kn1", secret: SECRETS.nvidia, tier: "free" },
    openrouter: { id: "ko1", secret: SECRETS.openrouter, tier: "free" },
    "fireworks-ai": { id: "kf1", secret: SECRETS.groq, tier: "paid" },
  },
  u2: {},
}
/** The engine start each workspace's token is bound to (sandboxes.last_session_started_at) and whether it is live. */
const SESSION = Date.now() - 60_000
const sessions = { u1: { w1: { startedAt: SESSION, live: true }, w9: { startedAt: SESSION, live: true } }, u2: { w2: { startedAt: SESSION, live: true } } }
const dbState = { loads: 0, fail: false, delayMs: 0, hang: false }
async function loadKeys(userId) {
  dbState.loads++
  if (dbState.delayMs) await sleep(dbState.delayMs)
  if (dbState.hang) await new Promise(() => {})
  if (dbState.fail) throw new Error("database unreachable")
  return { keys: new Map(Object.entries(db[userId] ?? {}).map(([p, k]) => [p, { id: k.id, secret: k.secret, tier: k.tier }])), sessions: new Map(Object.entries(sessions[userId] ?? {}).map(([w, s]) => [w, { ...s }])) }
}
/** The relay key cache's clock runs ahead by this much (tests move it instead of waiting). */
const kclk = { offset: 0 }
const CACHE_OPTS = { freshMs: 10_000, maxAgeMs: 3_600_000, failGraceMs: 60_000, loadTimeoutMs: 4_000, reloadGapMs: 1_000, now: () => Date.now() + kclk.offset }
const newCache = () => new R.KeyCache(loadKeys, CACHE_OPTS)
let cache = newCache()
const lookups = []
async function lookup(userId, opts = {}) {
  lookups.push([userId, !!opts.reload])
  return opts.reload ? cache.reload(userId) : cache.get(userId)
}
const meta = (userId) => Object.fromEntries(Object.entries(db[userId] ?? {}).map(([p, k]) => [p, { id: k.id, tier: k.tier }]))

/** A small models.dev: what the app's relay checks a paid key's model against. */
function MD(id, o = {}) {
  return {
    id,
    name: id,
    tool_call: o.tools ?? true,
    reasoning: false,
    attachment: false,
    release_date: "2026-07-01",
    cost: o.cost ?? { input: 0, output: 0 },
    limit: { context: o.context ?? 200_000, output: o.output ?? 32_000 },
  }
}
const MODELS_DEV = {
  google: { id: "google", models: { "gemini-3.8-flash": MD("gemini-3.8-flash", { cost: { input: 0.3, output: 2.5 } }), "gemini-3.8-pro": MD("gemini-3.8-pro", { cost: { input: 2, output: 12 } }) } },
  openrouter: {
    id: "openrouter",
    models: { "openai/gpt-oss-20b:free": MD("openai/gpt-oss-20b:free"), "openrouter/zero": MD("openrouter/zero"), "anthropic/claude-opus-4": MD("anthropic/claude-opus-4", { cost: { input: 15, output: 75 } }) },
  },
  "fireworks-ai": {
    id: "fireworks-ai",
    models: {
      "accounts/fireworks/models/glm-5": MD("accounts/fireworks/models/glm-5", { cost: { input: 0.5, output: 2 }, output: 32_000 }),
      "accounts/fireworks/models/qwen-embed": MD("accounts/fireworks/models/qwen-embed", { tools: false }),
    },
  },
  "some-other-provider": { id: "some-other-provider", models: { x: MD("x") } },
}
const catState = { loads: 0, fail: false }
const catalog = new R.CatalogCache(async () => {
  catState.loads++
  if (catState.fail) throw new Error("models.dev unreachable")
  return R.catalogFromModelsDev(MODELS_DEV, Object.keys(PROVIDER_BASE))
})

const TOK = R.mintIngestToken("u1", "w1", 60 * 60_000, SESSION)
const TOK2 = R.mintIngestToken("u2", "w2", 60 * 60_000, SESSION)
const EXPIRED = R.mintIngestToken("u1", "w1", -1000, SESSION)
/** Minted before tokens were bound to a sandbox session: it could never be revoked. */
const UNBOUND = R.mintIngestToken("u1", "w1", 60 * 60_000)
const [tokBody, tokSig] = TOK.split(".")
const TAMPERED = `${tokBody}.${tokSig.slice(0, -2)}${tokSig.endsWith("AA") ? "BB" : "AA"}`
const FORGED = `${Buffer.from(JSON.stringify({ u: "u2", w: "w1", exp: Date.now() + 3_600_000, s: SESSION })).toString("base64url")}.${tokSig}`

const relayLogs = []
function relayWith(over = {}) {
  return R.createRelay({ verify: R.verifyIngestToken, lookup, catalog, baseURL: PROVIDER_BASE, deadlineMs: 290_000, log: (event, data, level) => relayLogs.push({ event, data, level }), ...over })
}
function chatBody(extra = {}) {
  return JSON.stringify({ model: "gemini-3.8-flash", stream: true, messages: [{ role: "user", content: "hi" }], ...extra })
}
function mkReq(method, { token = TOK, auth, headers = {}, body, signal } = {}) {
  const h = { ...headers }
  if (auth !== undefined) {
    if (auth !== null) h.authorization = auth
  } else if (token) h.authorization = `Bearer ${token}`
  if (body !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["content-type"] = "application/json"
  return new Request("http://app.test/api/ingest/llm/x", { method, headers: h, body, signal, duplex: "half" })
}
/** Everything the relay returned in the unit scenarios, for the leak check. */
const seen = []
async function record(res) {
  const text = await res.clone().text()
  seen.push(`${res.status} ${JSON.stringify([...res.headers])} ${text}`)
  return res
}

// ------------------------------------------------------------------ Node http ↔ Web Request adapter (what Next does for a route handler)

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "expect"])

function webServer(handle, opts = {}) {
  return http.createServer(async (req, res) => {
    const ac = new AbortController()
    res.on("close", () => {
      if (!res.writableFinished) ac.abort(new Error("client closed"))
    })
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k) || v === undefined) continue
      for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x)
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD"
    let response
    try {
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: "half", signal: ac.signal })
      response = await handle(request)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" })
      return res.end(String(err?.message ?? err))
    }
    const out = {}
    response.headers.forEach((v, k) => {
      out[k] = v
    })
    res.writeHead(response.status, out)
    res.flushHeaders()
    opts.capture?.(`${response.status} ${JSON.stringify(out)}`)
    if (!response.body) return res.end()
    const reader = response.body.getReader()
    // Next's pipeToNodeResponse cancels the body when the response closes early.
    res.on("close", () => void reader.cancel(new Error("client closed")).catch(() => {}))
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        opts.capture?.(Buffer.from(value).toString("utf8"))
        if (!res.write(value)) await new Promise((r) => (res.once("drain", r), res.once("close", r)))
      }
      res.end()
    } catch (err) {
      res.destroy(err)
    }
  })
}

// ------------------------------------------------------------------ mock syrup app: the relay + the ingest ops the sidecar calls

const app = {
  url: "",
  deadlineMs: 290_000,
  capturing: true,
  /** Everything sent back to the sidecar side (status, headers, bodies). */
  sent: [],
  llm: [],
  events: [],
  logs: [],
  relayLogs: [],
}
function bearer(req) {
  const a = req.headers.get("authorization") ?? ""
  return a.startsWith("Bearer ") ? a.slice(7) : ""
}
async function appHandle(req) {
  const u = new URL(req.url)
  const p = u.pathname
  if (p.startsWith("/api/ingest/llm/")) {
    let segs
    try {
      segs = p.slice("/api/ingest/llm/".length).split("/").map(decodeURIComponent)
    } catch {
      return Response.json({ error: "bad path" }, { status: 400 })
    }
    const [provider, ...rest] = segs
    app.llm.push({ method: req.method, path: p, provider, headers: Object.fromEntries(req.headers) })
    // One relay per app instance, as in production (its rejected-key memory lives as long as the route module).
    if (!app.relay || app.relayDeadline !== app.deadlineMs) {
      app.relayDeadline = app.deadlineMs
      app.relay = R.createRelay({ verify: R.verifyIngestToken, lookup, catalog, baseURL: PROVIDER_BASE, deadlineMs: app.deadlineMs, log: (event, data, level) => app.relayLogs.push({ event, data, level }) })
    }
    return app.relay(req, provider, rest)
  }
  const claims = R.verifyIngestToken(bearer(req))
  if (!claims) return Response.json({ error: "invalid ingest token" }, { status: 401 })
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {}
  if (req.method === "GET" && p === "/api/ingest/router/keys") return Response.json({ keys: meta(claims.u) }, { headers: { "cache-control": "no-store" } })
  if (req.method === "GET" && p === "/api/ingest/router/recent") return Response.json({ events: [] })
  if (req.method === "POST" && p === "/api/ingest/router") {
    app.events.push(...(body.events ?? []))
    return Response.json({ ok: true })
  }
  if (req.method === "POST" && p === "/api/ingest/logs") {
    app.logs.push(...(body.rows ?? []))
    return Response.json({ ok: true })
  }
  if (req.method === "POST" && p === "/api/ingest/events") return Response.json({ ok: true })
  if (req.method === "GET" && p === "/api/ingest/memory/version") return Response.json({ version: "1" })
  if (req.method === "POST" && p.startsWith("/api/ingest/memory/")) return Response.json([])
  return Response.json({ error: `unknown ${req.method} ${p}` }, { status: 404 })
}
const appServer = webServer(appHandle, { capture: (s) => app.capturing && app.sent.push(s) })
await new Promise((r) => appServer.listen(0, "127.0.0.1", r))
app.url = `http://127.0.0.1:${appServer.address().port}`

/** A raw HTTP request (no URL normalisation by the client), for path tricks. */
function rawRequest(method, rawPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: appServer.address().port, method, path: rawPath, headers }, (res) => {
      const parts = []
      res.on("data", (c) => parts.push(c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString("utf8") }))
    })
    r.on("error", reject)
    r.end(body)
  })
}

// ------------------------------------------------------------------ unit: the relay on its own

await scenario("1) tokens: missing, malformed, expired, tampered or forged → 401 before any key lookup or provider call", async () => {
  const relay = relayWith()
  lookups.length = 0
  const cases = [
    ["no header", null],
    ["empty bearer", "Bearer "],
    ["basic auth", `Basic ${Buffer.from(`x:${TOK}`).toString("base64")}`],
    ["lowercase scheme", `bearer ${TOK}`],
    ["garbage", "Bearer garbage"],
    ["no signature", `Bearer ${tokBody}`],
    ["expired", `Bearer ${EXPIRED}`],
    ["tampered signature", `Bearer ${TAMPERED}`],
    ["forged claims", `Bearer ${FORGED}`],
    ["a provider key instead", `Bearer ${SECRETS.google}`],
    ["a token not bound to a sandbox session", `Bearer ${UNBOUND}`],
  ]
  for (const [name, auth] of cases) {
    const res = await record(await relay(mkReq("POST", { auth, body: chatBody() }), "google", ["chat", "completions"]))
    eq(res.status, 401, name)
    eq(res.headers.get("x-syrup-relay-error"), "token", `${name}: marked as the relay's own answer`)
    eq((await res.json()).error.type, "syrup_relay_token", `${name}: error type`)
  }
  eq(lookups.length, 0, "no key lookup")
  eq(prov.hits.length, 0, "no provider call")
  const ok = await record(await relay(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"]))
  eq(ok.status, 200, "a valid token passes")
  await ok.text()
  const u2 = await record(await relay(mkReq("POST", { token: TOK2, body: chatBody() }), "google", ["chat", "completions"]))
  eq(u2.status, 401, "another user's token never reaches this user's key")
  eq((await u2.json()).error.type, "syrup_no_key", "u2 has no google key")
})

await scenario("2) route allow-list: unknown providers, other paths, traversal, smuggled queries and wrong methods never reach a provider", async () => {
  const relay = relayWith()
  lookups.length = 0
  const notFound = [
    ["__proto__", ["models"]],
    ["constructor", ["models"]],
    ["toString", ["models"]],
    ["hasOwnProperty", ["chat", "completions"]],
    ["cloudflare-workers-ai", ["models"]],
    ["evil.com", ["models"]],
    ["127.0.0.1:22", ["models"]],
    ["google@evil.com", ["models"]],
    ["..", ["models"]],
    ["", ["models"]],
    ["google", []],
    ["google", ["embeddings"]],
    ["google", ["chat"]],
    ["google", ["chat", "completions", "x"]],
    ["google", ["chat", "", "completions"]],
    ["google", ["..", "models"]],
    ["google", ["%2e%2e", "models"]],
    ["google", ["chat", "completions", "..", "..", "evil"]],
    ["google", ["chat/completions/../../evil"]],
    ["google", ["models", ""]],
    ["google", ["models?key=x"]],
    ["google", ["models#x"]],
    ["google", ["MODELS"]],
    ["google", ["v1", "chat", "completions"]],
  ]
  for (const [p, segs] of notFound) {
    const method = segs.join("/").startsWith("chat") ? "POST" : "GET"
    const res = await record(await relay(mkReq(method, method === "POST" ? { body: chatBody() } : {}), p, segs))
    eq(res.status, 404, `${p} / ${JSON.stringify(segs)}`)
    eq((await res.json()).error.type, "syrup_relay_not_found", `${p} / ${JSON.stringify(segs)}: error type`)
  }
  const wrong = await record(await relay(mkReq("GET"), "google", ["chat", "completions"]))
  eq(wrong.status, 405, "GET chat/completions")
  eq(wrong.headers.get("allow"), "POST", "names the method")
  eq((await record(await relay(mkReq("POST", { body: "{}" }), "google", ["models"]))).status, 405, "POST models")
  eq((await record(await relay(mkReq("PUT", { body: "{}" }), "google", ["chat", "completions"]))).status, 405, "PUT chat/completions")
  eq((await record(await relay(mkReq("DELETE"), "google", ["models"]))).status, 405, "DELETE models")
  eq(lookups.length, 0, "no key lookup for a refused route")
  eq(prov.hits.length, 0, "no provider call for a refused route")

  // Over real HTTP, where the URL parser and the route's decoding come into play.
  for (const raw of [
    "/api/ingest/llm/google/%2e%2e/%2e%2e/evil",
    "/api/ingest/llm/google/..%2f..%2fevil",
    "/api/ingest/llm/google/chat%2Fcompletions%2F..%2F..%2Fx",
    "/api/ingest/llm/%5f%5fproto%5f%5f/models",
    "/api/ingest/llm/google/%zz",
  ]) {
    const r = await rawRequest("POST", raw, { authorization: `Bearer ${TOK}`, "content-type": "application/json" }, "{}")
    assert(r.status === 404 || r.status === 400, `${raw}: refused (${r.status})`)
  }
  eq(prov.hits.length, 0, "no provider call for path tricks over HTTP")

  // An encoded slash that decodes to an allowed suffix still calls only the fixed URL; the query string is never forwarded.
  const enc = await rawRequest("POST", "/api/ingest/llm/google/chat%2Fcompletions?key=SMUGGLED&alt=sse&url=http://evil", { authorization: `Bearer ${TOK}`, "content-type": "application/json" }, chatBody())
  eq(enc.status, 200, "decoded allowed suffix")
  eq(prov.hits.length, 1, "one provider call")
  eq(prov.hits[0].path, "/google/chat/completions", "the fixed upstream path")
  eq(prov.hits[0].search, "", "no query string forwarded")

  // A redirect from the provider is passed back, never followed.
  prov.set("google", status(302, "{}", { location: "http://169.254.169.254/latest/meta-data" }))
  const redir = await record(await relay(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"]))
  eq(redir.status, 302, "redirect status passed back")
  eq(redir.headers.get("location"), null, "no location header passed back")
  eq(prov.hits.length, 2, "redirect not followed")
})

await scenario("3) headers: the provider sees the real key and the allowed headers only; the sidecar gets the learnable headers only", async () => {
  const payload = { id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }
  prov.set("openrouter", async (req, res) => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)))
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(gz.length),
      "retry-after": "7",
      "x-request-id": "rid-1",
      "x-ratelimit-remaining-requests": "41",
      "x-ratelimit-reset-tokens": "1m2s",
      "set-cookie": "sess=provider-cookie",
      "x-powered-by": "mock",
      location: "http://evil",
      "access-control-allow-origin": "*",
    })
    res.end(gz)
  })
  const body = chatBody({ model: "openai/gpt-oss-20b:free", stream: false })
  const res = await fetch(`${app.url}/api/ingest/llm/openrouter/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOK}`,
      "content-type": "application/json",
      accept: "application/json",
      cookie: "session=browser-cookie",
      "x-forwarded-for": "10.0.0.1",
      "x-forwarded-host": "evil.example",
      "x-real-ip": "10.0.0.2",
      forwarded: "for=10.0.0.3",
      "x-vercel-id": "fra1::abc",
      "x-vercel-ip-country": "DE",
      "http-referer": "https://github.com/SyedSaribSultan/syrup",
      "x-title": "syrup",
      "x-session-affinity": "ses_123",
      "x-custom": "nope",
      "user-agent": "client-ua",
      "proxy-authorization": "Basic eA==",
    },
    body,
  })
  eq(res.status, 200, "status")
  const hit = prov.hits.at(-1)
  eq(hit.headers.authorization, `Bearer ${SECRETS.openrouter}`, "the provider gets the real key")
  eq(hit.headers["content-type"], "application/json", "content-type")
  eq(hit.headers.accept, "application/json", "accept passed on")
  eq(hit.headers["http-referer"], "https://github.com/SyedSaribSultan/syrup", "OpenRouter referer passed on")
  eq(hit.headers["x-title"], "syrup", "OpenRouter title passed on")
  eq(hit.headers["x-session-affinity"], "ses_123", "affinity passed on")
  for (const h of ["cookie", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "x-vercel-id", "x-vercel-ip-country", "x-custom", "proxy-authorization"]) eq(hit.headers[h], undefined, `${h} dropped`)
  assert(hit.headers["user-agent"] !== "client-ua", "the client's user-agent is not passed on")
  assert(!JSON.stringify(hit.headers).includes(TOK) && !hit.path.includes(TOK) && !hit.search.includes(TOK), "the ingest token never reaches the provider")
  eq(hit.raw.toString("utf8"), body, "body passed on byte for byte")
  eq(hit.headers["content-length"], String(Buffer.byteLength(body)), "a real content-length")
  eq(res.headers.get("retry-after"), "7", "retry-after kept")
  eq(res.headers.get("x-request-id"), "rid-1", "x-request-id kept")
  eq(res.headers.get("x-ratelimit-remaining-requests"), "41", "x-ratelimit-remaining-requests kept")
  eq(res.headers.get("x-ratelimit-reset-tokens"), "1m2s", "x-ratelimit-reset-tokens kept")
  for (const h of ["set-cookie", "x-powered-by", "location", "access-control-allow-origin", "content-encoding", "content-length"]) eq(res.headers.get(h), null, `${h} stripped`)
  eq(res.headers.get("x-syrup-key-id"), "ko1", "names the key id it used")
  assert(/no-transform/.test(res.headers.get("cache-control") ?? ""), "no-transform")
  eq(res.headers.get("x-accel-buffering"), "no", "x-accel-buffering")
  assert(/^auth;dur=[\d.]+, key;dur=[\d.]+;desc=(hit|miss), upstream;dur=[\d.]+$/.test(res.headers.get("server-timing") ?? ""), `server-timing (${res.headers.get("server-timing")})`)
  eq(JSON.stringify(await res.json()), JSON.stringify(payload), "the decoded body arrives intact")
  const st = R.parseServerTiming(res.headers.get("server-timing"))
  assert(typeof st.upstream?.dur === "number" && typeof st.auth?.dur === "number", "server-timing parses")
})

await scenario("4) streaming is unbuffered: the first chunk arrives while the provider is still writing", async () => {
  const marks = {}
  prov.set("google", async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('data: {"choices":[{"index":0,"delta":{"content":"one"}}]}\n\n')
    marks.w1 = performance.now()
    await sleep(500)
    marks.w2 = performance.now()
    res.end('data: {"choices":[{"index":0,"delta":{"content":"two"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  const res = await fetch(`${app.url}/api/ingest/llm/google/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" }, body: chatBody() })
  eq(res.status, 200, "status")
  eq(res.headers.get("content-type"), "text/event-stream", "content-type passed back")
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let text = ""
  while (!text.includes("one")) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  const r1 = performance.now()
  assert(!text.includes("two"), "chunk 1 arrived on its own")
  assert(r1 - marks.w1 < 50, `chunk 1 within 50 ms of the write (${(r1 - marks.w1).toFixed(1)} ms)`)
  assert(marks.w2 === undefined || r1 < marks.w2, "chunk 1 arrived before chunk 2 was written")
  while (!text.includes("[DONE]")) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  const r2 = performance.now()
  assert(r2 - marks.w2 < 50, `chunk 2 within 50 ms of the write (${(r2 - marks.w2).toFixed(1)} ms)`)
  assert(text.includes("two"), "chunk 2 arrived")
})

await scenario("5) failure statuses pass through unchanged: the router classifies them exactly as it would direct", async () => {
  const GOOGLE_PER_DAY = [
    {
      error: {
        code: 429,
        message: "You exceeded your current quota",
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
        ],
      },
    },
  ]
  const cases = [
    ["google 429 per day", 429, GOOGLE_PER_DAY, { "retry-after": "41" }],
    ["429 retry-after", 429, { error: { message: "Rate limit reached" } }, { "retry-after": "30", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "30s" }],
    ["401", 401, { error: { message: "Incorrect API key provided" } }, {}],
    ["400 key invalid", 400, [{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }], {}],
    ["503 overloaded", 503, { error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }, {}],
    ["400 context", 400, { error: { message: "This model's maximum context length is 131072 tokens. However, your messages resulted in 140000 tokens." } }, {}],
    ["404 retired model", 404, { error: { message: "model gemini-0 is no longer available" } }, {}],
    ["413 from the provider", 413, { error: { message: "Request too large" } }, {}],
    ["402", 402, { error: { message: "Insufficient credits" } }, {}],
  ]
  const now = Date.now()
  for (const [name, code, body, headers] of cases) {
    prov.set("google", status(code, body, headers))
    const direct = await fetch(`${prov.url}/google/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody() })
    const via = await fetch(`${app.url}/api/ingest/llm/google/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" }, body: chatBody() })
    eq(via.status, direct.status, `${name}: status`)
    const [dt, vt] = [await direct.text(), await via.text()]
    eq(vt, dt, `${name}: body`)
    const [dh, vh] = [pick(direct.headers), pick(via.headers)]
    eq(JSON.stringify(vh), JSON.stringify(dh), `${name}: learnable headers`)
    const a = R.classifyFailure({ status: direct.status, headers: dh, body: dt, providerID: "google", promptTokens: 1000, now })
    const b = R.classifyFailure({ status: via.status, headers: vh, body: vt, providerID: "google", promptTokens: 1000, now })
    eq(JSON.stringify(b), JSON.stringify(a), `${name}: classification`)
  }
})

await scenario("6) a client that goes away closes the provider connection: before headers (signal) and mid-stream (cancel), directly and over HTTP", async () => {
  const relay = relayWith()
  // (a) before the provider answered: the request's signal.
  prov.set("google", hang())
  const ac = new AbortController()
  const pending = relay(mkReq("POST", { body: chatBody(), signal: ac.signal }), "google", ["chat", "completions"])
  await waitFor(() => prov.hits.length === 1, 2000, "provider reached")
  const t0 = performance.now()
  ac.abort()
  const r = await pending
  assert(r.status >= 500, `an error answer once the client is gone (${r.status})`)
  await waitFor(() => prov.hits[0].closed, 1000, "provider socket closed after abort (signal)")
  assert(prov.hits[0].closedAt - t0 < 1000, "within 1 s")

  // (b) mid-stream: the response body is cancelled, the request's signal never fires.
  prov.set("google", ticking(50))
  const res = await relay(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"])
  const reader = res.body.getReader()
  await reader.read()
  await reader.read()
  const t1 = performance.now()
  await reader.cancel()
  await waitFor(() => prov.hits[1].closed, 1000, "provider socket closed after cancel")
  assert(prov.hits[1].closedAt - t1 < 1000, "within 1 s")

  // (c) over HTTP: the sidecar's connection drops mid-stream.
  const ac2 = new AbortController()
  const viaHttp = await fetch(`${app.url}/api/ingest/llm/google/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
    body: chatBody(),
    signal: ac2.signal,
  })
  const rd = viaHttp.body.getReader()
  await rd.read()
  const t2 = performance.now()
  ac2.abort()
  await waitFor(() => prov.hits[2]?.closed, 1000, "provider socket closed after the HTTP client went away")
  assert(prov.hits[2].closedAt - t2 < 1000, "within 1 s")
})

await scenario("7) deadline: a stream still running is closed cleanly and the provider connection closed; before headers it is a 504", async () => {
  relayLogs.length = 0
  prov.set("google", ticking(50))
  const relay = relayWith({ deadlineMs: 300 })
  const t0 = performance.now()
  const res = await relay(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"])
  eq(res.status, 200, "status")
  const text = await res.text()
  const took = performance.now() - t0
  assert(text.includes("tick0") && took >= 250 && took < 1500, `clean close after about 300 ms (${took.toFixed(0)} ms)`)
  await waitFor(() => prov.hits[0].closed, 1000, "provider socket closed at the deadline")
  const cut = relayLogs.find((l) => l.event === "relay.deadline_cut")
  assert(cut && cut.level === "warn" && cut.data.provider === "google", "relay.deadline_cut logged at warn")

  prov.set("google", hang())
  const early = await record(await relayWith({ deadlineMs: 200 })(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"]))
  eq(early.status, 504, "no headers before the deadline")
  eq((await early.json()).error.type, "syrup_relay_deadline", "error type")
  await waitFor(() => prov.hits[1].closed, 1000, "provider socket closed")
})

await scenario("8) key lookup: no key → 401 syrup_no_key; database down → 503 with retry-after; neither calls a provider", async () => {
  const relay = relayWith()
  const none = await record(await relay(mkReq("POST", { body: chatBody() }), "groq", ["chat", "completions"]))
  eq(none.status, 401, "no groq key")
  const j = await none.json()
  eq(j.error.type, "syrup_no_key", "error type")
  eq(j.error.message, "no active groq key in syrup", "message")
  eq(
    R.classifyFailure({ status: 401, headers: { "x-syrup-relay-error": "no_key" }, body: JSON.stringify(j), providerID: "groq", promptTokens: 10, now: Date.now() }).reason,
    "auth",
    "the router reads it as a rejected key",
  )
  const down = await record(
    await relayWith({
      lookup: async () => {
        throw new Error("pool exhausted for postgres://user:hunter2-db-password@db")
      },
    })(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"]),
  )
  eq(down.status, 503, "database down")
  assert(Number(down.headers.get("retry-after")) > 0, "retry-after")
  eq(down.headers.get("x-syrup-relay-error"), "unavailable", "marked: the app failed, not the provider")
  eq(none.headers.get("x-syrup-relay-error"), "no_key", "no key is marked too")
  const dj = await down.json()
  eq(dj.error.type, "syrup_relay_unavailable", "error type")
  assert(!JSON.stringify(dj).includes("hunter2"), "the error body never carries the cause's details")
  eq(prov.hits.length, 0, "no provider call")
})

await scenario("9) request bodies: gzip is inflated with a real content-length; bombs, bad gzip, other encodings and other types are refused", async () => {
  const relay = relayWith()
  const big = chatBody({ messages: [{ role: "user", content: "x".repeat(200_000) }] })
  const gz = zlib.gzipSync(Buffer.from(big))
  const ok = await relay(mkReq("POST", { body: gz, headers: { "content-type": "application/json", "content-encoding": "gzip" } }), "google", ["chat", "completions"])
  eq(ok.status, 200, "gzip accepted")
  await ok.text()
  const hit = prov.hits.at(-1)
  eq(hit.raw.toString("utf8"), big, "the provider receives the identical JSON")
  eq(hit.headers["content-length"], String(Buffer.byteLength(big)), "with its real length")
  eq(hit.headers["content-encoding"], undefined, "and no content-encoding")
  const n = prov.hits.length

  const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024))
  const b = await record(await relay(mkReq("POST", { body: bomb, headers: { "content-type": "application/json", "content-encoding": "gzip" } }), "google", ["chat", "completions"]))
  eq(b.status, 400, `a ${(bomb.length / 1024).toFixed(0)} KB body inflating to 40 MB is refused`)
  const bad = await record(await relay(mkReq("POST", { body: "not gzip", headers: { "content-type": "application/json", "content-encoding": "gzip" } }), "google", ["chat", "completions"]))
  eq(bad.status, 400, "invalid gzip")
  eq((await record(await relay(mkReq("POST", { body: "{}", headers: { "content-type": "application/json", "content-encoding": "br" } }), "google", ["chat", "completions"]))).status, 415, "brotli refused")
  eq((await record(await relay(mkReq("POST", { body: "{}", headers: { "content-type": "text/plain" } }), "google", ["chat", "completions"]))).status, 415, "text/plain refused")
  const huge = await record(await relay(mkReq("POST", { body: Buffer.alloc(9 * 1024 * 1024, 0x20) }), "google", ["chat", "completions"]))
  eq(huge.status, 400, "a 9 MB raw body is refused")
  eq((await huge.json()).error.type, "syrup_relay_too_large", "error type")
  eq(prov.hits.length, n, "none of them reached the provider")
})

await scenario(
  "10) key cache: fresh, stale-while-revalidate for an hour (no blocking expiry at 10 min), shared loads, forget, failed refreshes ridden out for a minute only, hung loads cut at their timeout, reload gap, LRU cap",
  async () => {
    let t = 1_000_000
    const loads = []
    let failing = false
    let hang = false
    let gate = null
    const kc = new R.KeyCache(
      async (u) => {
        loads.push(u)
        if (hang) return new Promise(() => {})
        if (gate) await gate
        if (failing) throw new Error("db down")
        return `${u}@${loads.length}`
      },
      { freshMs: 10_000, maxAgeMs: 3_600_000, failGraceMs: 60_000, loadTimeoutMs: 200, reloadGapMs: 1_000, maxUsers: 3, now: () => t },
    )
    let r = await kc.get("a")
    eq(`${r.value}/${r.hit}`, "a@1/false", "first read loads")
    r = await kc.get("a")
    eq(`${r.value}/${r.hit}/${loads.length}`, "a@1/true/1", "fresh hit, no load")
    t += 10_001
    r = await kc.get("a")
    eq(`${r.value}/${r.hit}`, "a@1/true", "stale value served at once")
    await settle()
    eq(loads.length, 2, "one background refresh")
    r = await kc.get("a")
    eq(r.value, "a@2", "refreshed value")
    // The first message after a long pause never waits on the database (the old cache blocked past 10 minutes).
    t += 50 * 60_000
    r = await kc.get("a")
    eq(`${r.value}/${r.hit}`, "a@2/true", "50 minutes later: still served at once")
    await settle()
    eq(loads.length, 3, "and refreshed in the background")

    let release
    gate = new Promise((res) => (release = res))
    const ps = [kc.get("b"), kc.get("b"), kc.get("b")]
    await settle()
    eq(loads.filter((x) => x === "b").length, 1, "concurrent misses share one load")
    release()
    gate = null
    const rs = await Promise.all(ps)
    assert(
      rs.every((x) => x.value === rs[0].value && !x.hit),
      "all get the same loaded value",
    )

    kc.forget("a")
    r = await kc.get("a")
    eq(r.hit, false, "forget drops the entry")

    // A forget while a load is in flight: that load's value is not cached.
    gate = new Promise((res) => (release = res))
    t += 3_600_001
    const inflight = kc.get("a")
    await settle()
    kc.forget("a")
    release()
    gate = null
    await inflight
    r = await kc.get("a")
    eq(r.hit, false, "a load that raced a forget is not cached")

    // A failed refresh keeps the old value for a minute (a database blip), then calls wait for the database and fail.
    t += 10_001
    failing = true
    const before = (await kc.get("a")).value
    await settle()
    t += 30_000
    r = await kc.get("a")
    eq(`${r.value}/${r.hit}`, `${before}/true`, "30 s into a failing database: the old value is still served")
    await settle()
    t += 31_000
    const threw = await kc.get("a").then(
      () => false,
      () => true,
    )
    assert(threw, "past the minute of grace a failing database is an error, not the old key")
    failing = false
    r = await kc.get("a")
    eq(r.hit, false, "the database back: a fresh read")

    // A load that never settles (a dead connection) gives up at its timeout instead of holding every caller.
    hang = true
    t += 3_600_001
    const t0 = performance.now()
    const timedOut = await kc.get("a").then(
      () => false,
      (e) => /longer than/.test(String(e?.message)),
    )
    assert(timedOut && performance.now() - t0 < 1000, `a hung load fails at its timeout (${(performance.now() - t0).toFixed(0)} ms)`)
    hang = false
    r = await kc.get("a")
    eq(r.hit, false, "the next call starts a new load instead of waiting on the hung one")

    // reload(): a read under a second old is reused; an older one is redone.
    const n0 = loads.length
    r = await kc.reload("a")
    eq(`${r.hit}/${loads.length - n0}`, "true/0", "reload right after a read reuses it")
    t += 1_001
    r = await kc.reload("a")
    eq(`${r.hit}/${loads.length - n0}`, "false/1", "reload a second later reads again")

    // LRU: a, b present (cap 3); touching a, then adding c and d evicts b first.
    t += 1
    await kc.get("b")
    await kc.get("a")
    await kc.get("c")
    await kc.get("d")
    eq(kc.size, 3, "capped at 3 users")
    const nb = loads.length
    await kc.get("b")
    eq(loads.length, nb + 1, "the least recently used user was evicted")

    // One load per user covers every provider and every workspace session.
    cache = newCache()
    const l0 = dbState.loads
    await Promise.all([lookup("u1"), lookup("u1"), lookup("u1")])
    eq(dbState.loads - l0, 1, "one database load for three calls")
    eq((await lookup("u1")).hit, true, "then served from the cache")

    // A provider rejecting a cached key: the next call for that provider (only) reads the database first.
    kclk.offset += 2_000
    const relay = relayWith()
    prov.set("google", status(401, { error: { message: "API key expired" } }))
    const res = await relay(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"])
    eq(res.status, 401, "provider 401 passed back")
    await res.text()
    prov.set("google", sseOk())
    const l1 = dbState.loads
    const nv = await relay(mkReq("POST", { body: chatBody({ model: "moonshotai/kimi-k3" }) }), "nvidia", ["chat", "completions"])
    await nv.text()
    eq(dbState.loads - l1, 0, "another provider's call still comes from the cache")
    const g = await relay(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"])
    await g.text()
    eq(dbState.loads - l1, 1, "the rejected provider's next call reads the database")
    // A 403 that does not blame the key (moderation) re-reads nothing.
    kclk.offset += 2_000
    prov.set("openrouter", status(403, { error: { message: "Your input was flagged by moderation" } }))
    const mod = await relay(mkReq("POST", { body: chatBody({ model: "openai/gpt-oss-20b:free" }) }), "openrouter", ["chat", "completions"])
    await mod.text()
    await settle()
    prov.set("openrouter", sseOk())
    const l2 = dbState.loads
    const again = await relay(mkReq("POST", { body: chatBody({ model: "openai/gpt-oss-20b:free" }) }), "openrouter", ["chat", "completions"])
    await again.text()
    eq(dbState.loads - l2, 0, "a moderation 403 leaves the key cache alone")
  },
)

await scenario("12) spend policy: a paid key calls only catalog models the router could pick, capped, logged; a free key only what a free key serves; n is refused", async () => {
  const relay = relayWith()
  relayLogs.length = 0
  const call = async (provider, extra) => record(await relay(mkReq("POST", { body: chatBody(extra) }), provider, ["chat", "completions"]))
  const refused = async (provider, extra, why) => {
    const n = prov.hits.length
    const res = await call(provider, extra)
    eq(res.status, 403, `${why}: refused`)
    eq(res.headers.get("x-syrup-relay-error"), "policy", `${why}: marked as policy`)
    eq((await res.json()).error.type, "syrup_relay_policy", `${why}: error type`)
    eq(prov.hits.length, n, `${why}: no provider call`)
  }
  // The finding: a token holder calling an expensive model, several answers, a huge output budget.
  await refused("fireworks-ai", { model: "accounts/fireworks/models/o3-pro", n: 8, max_tokens: 100_000 }, "paid key, model not in the catalog")
  await refused("fireworks-ai", { model: "accounts/fireworks/models/qwen-embed" }, "paid key, a model the router cannot pick (no tools)")
  await refused("fireworks-ai", { model: "accounts/fireworks/models/glm-5", n: 4 }, "n > 1")
  await refused("openrouter", { model: "anthropic/claude-opus-4" }, "free OpenRouter key, a priced model (the account's credits)")
  await refused("openrouter", { model: "openai/gpt-4o" }, "free OpenRouter key, a model not in the catalog")
  await refused("google", { model: "gemini-3.8-pro" }, "free Google key, a model with no free quota")
  assert(
    relayLogs.some((l) => l.event === "relay.policy_refused" && l.level === "warn" && l.data.userId === "u1"),
    "refusals are logged with the user",
  )
  const cls = R.classifyFailure({ status: 403, headers: { "x-syrup-relay-error": "policy" }, body: JSON.stringify({ error: { message: "x" } }), providerID: "fireworks-ai", promptTokens: 10, now: 0 })
  eq(`${cls.reason}/${cls.scope}/${cls.unhealthy}/${cls.retryAt}`, "error/backend/false/3600000", "the router benches that backend for an hour, no health penalty")

  // Allowed: the router's own picks.
  const ok = await call("fireworks-ai", { model: "accounts/fireworks/models/glm-5", max_tokens: 1_000_000 })
  eq(ok.status, 200, "paid key, a catalog model")
  await ok.text()
  eq(prov.hits.at(-1).body.max_tokens, 32_000, "max_tokens capped at the model's output limit")
  const start = relayLogs.find((l) => l.event === "relay.paid_call")
  assert(
    start &&
      start.data.userId === "u1" &&
      start.data.provider === "fireworks-ai" &&
      start.data.model === "accounts/fireworks/models/glm-5" &&
      start.data.maxTokens === 32_000 &&
      start.data.capped === true &&
      start.data.costs === true,
    `paid call logged (${JSON.stringify(start?.data)})`,
  )
  const used = relayLogs.find((l) => l.event === "relay.paid_usage")
  assert(used && used.data.promptTokens === 100 && used.data.completionTokens === 20 && used.data.ended === "done", `paid usage logged with tokens (${JSON.stringify(used?.data)})`)
  for (const [provider, model] of [
    ["openrouter", "openai/gpt-oss-20b:free"],
    ["openrouter", "openrouter/zero"],
    ["google", "gemini-3.8-flash"],
  ]) {
    const r = await call(provider, { model })
    eq(r.status, 200, `${provider} free key, ${model}`)
    await r.text()
  }
  eq(relayLogs.filter((l) => l.event === "relay.paid_call").length, 1, "free keys are not logged as spend")
  eq(prov.hits.at(-1).raw.toString("utf8"), chatBody({ model: "gemini-3.8-flash" }), "an uncapped body passes byte for byte")

  // The catalog unreachable: a paid key fails as the app's own error; a free key with a name rule never needed it.
  const catDown = relayWith({ catalog: new R.CatalogCache(async () => Promise.reject(new Error("down"))) })
  const pd = await record(await catDown(mkReq("POST", { body: chatBody({ model: "accounts/fireworks/models/glm-5" }) }), "fireworks-ai", ["chat", "completions"]))
  eq(`${pd.status}/${pd.headers.get("x-syrup-relay-error")}`, "503/unavailable", "paid key without a catalog: 503, marked")
  await pd.text()
  const fd = await catDown(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"])
  eq(fd.status, 200, "free Google key without a catalog")
  await fd.text()
  const bad = await record(await relay(mkReq("POST", { body: "[1,2]" }), "google", ["chat", "completions"]))
  eq(`${bad.status}/${bad.headers.get("x-syrup-relay-error")}`, "400/bad_request", "a body that is not a JSON object")

  // Pure: the usage sniffer reads numbers split across chunks.
  const us = new R.UsageSniffer()
  const enc = new TextEncoder()
  us.push(enc.encode('data: {"usage":{"prompt_tok'))
  us.push(enc.encode('ens":12'))
  us.push(enc.encode('34,"completion_tokens":5}}\n\n'))
  eq(`${us.prompt}/${us.completion}`, "1234/5", "usage split across chunks")
})

await scenario("13) tokens are bound to a sandbox session: stopping, deleting or restarting the workspace ends the old token at the relay", async () => {
  const relay = relayWith()
  const call = async (tok) => record(await relay(mkReq("POST", { token: tok, body: chatBody() }), "google", ["chat", "completions"]))
  cache = newCache()
  try {
    const first = await call(TOK)
    eq(first.status, 200, "the live session's token")
    await first.text()
    // Stopped (sandboxes.status = stopped): within the cache's fresh window plus one call, the token is refused.
    sessions.u1.w1.live = false
    kclk.offset += 11_000
    const stale = await call(TOK)
    await stale.text()
    await settle()
    await sleep(20)
    const stopped = await call(TOK)
    eq(stopped.status, 401, "a stopped workspace's token is refused")
    eq(stopped.headers.get("x-syrup-relay-error"), "token", "marked as a token problem")
    eq((await stopped.json()).error.message, "this sandbox session has ended", "says why")
    // Restarted: the new session's token works at once (the relay re-reads when the stamp differs from its cache), the old one does not.
    const NEXT = SESSION + 5_000
    sessions.u1.w1 = { startedAt: NEXT, live: true }
    kclk.offset += 2_000
    const tokNext = R.mintIngestToken("u1", "w1", 60 * 60_000, NEXT)
    const fresh = await call(tokNext)
    eq(fresh.status, 200, "the new session's token works on its first call")
    await fresh.text()
    const old = await call(TOK)
    eq(old.status, 401, "the previous session's token is refused")
    await old.text()
    // Deleted: no session row at all. Like a stop, it shows once the cache's fresh window has passed (one more call).
    delete sessions.u1.w1
    kclk.offset += 11_000
    await (await call(tokNext)).text()
    await settle()
    await sleep(20)
    const gone = await call(tokNext)
    eq(gone.status, 401, "a deleted workspace's token is refused")
    await gone.text()
  } finally {
    sessions.u1.w1 = { startedAt: SESSION, live: true }
    cache = newCache()
  }
  eq(R.verifyIngestToken(TOK).s, SESSION, "the stamp is signed into the token")
})

await scenario("14) the sidecar's expected key: the relay never uses another key without reading the database first", async () => {
  const relay = relayWith()
  const call = async (expect) => relay(mkReq("POST", { body: chatBody(), headers: expect ? { "x-syrup-expect-key": expect } : {} }), "google", ["chat", "completions"])
  cache = newCache()
  await (await call("kg1")).text()
  // A key switched in Settings on another instance: this instance's cache still has kg1; the sidecar already expects kg2.
  db.u1.google = { id: "kg2", secret: SECRETS.google2, tier: "free" }
  kclk.offset += 2_000
  const l0 = dbState.loads
  const sw = await call("kg2")
  eq(sw.status, 200, "status")
  await sw.text()
  eq(prov.hits.at(-1).headers.authorization, `Bearer ${SECRETS.google2}`, "the expected key's secret at the provider")
  eq(sw.headers.get("x-syrup-key-id"), "kg2", "and named back")
  eq(dbState.loads - l0, 1, "one database read")
  // A sidecar a little behind (still expects kg1): the relay re-reads at most once a second and uses the database's key.
  const lag = await call("kg1")
  await lag.text()
  eq(lag.headers.get("x-syrup-key-id"), "kg2", "the database's key, named back so the sidecar catches up")
  eq(dbState.loads - l0, 1, "no extra read within a second")
  // The database down while the expected key differs: refused, never the cached key the sidecar no longer books to.
  db.u1.google = { id: "kg3", secret: SECRETS.google, tier: "free" }
  dbState.fail = true
  kclk.offset += 2_000
  const n = prov.hits.length
  const down = await call("kg3")
  eq(`${down.status}/${down.headers.get("x-syrup-relay-error")}`, "503/unavailable", "503, marked")
  await down.text()
  eq(prov.hits.length, n, "no provider call with the old key")
  dbState.fail = false
  db.u1.google = { id: "kg1", secret: SECRETS.google, tier: "free" }
  cache = newCache()
})

await scenario("15) app-side failures are marked, and the router holds none of them against a provider", async () => {
  const now = 1_000_000
  const cls = (status, kind, body = { error: { message: "x" } }) =>
    R.classifyFailure({ status, headers: kind ? { "x-syrup-relay-error": kind } : {}, body: JSON.stringify(body), providerID: "google", promptTokens: 5000, now })
  for (const [status, kind] of [
    [503, "unavailable"],
    [401, "token"],
    [500, "platform"],
  ]) {
    const c = cls(status, kind)
    eq(`${c.reason}/${c.scope}/${c.unhealthy}/${c.retryAt}`, "relay/none/false/null", `${kind}: no cooldown, no health penalty`)
  }
  const up = cls(502, "upstream")
  eq(`${up.reason}/${up.unhealthy}/${up.retryAt - now}`, "network/true/15000", "the relay unable to reach the provider reads as a network error, as direct")
  eq(cls(503, null).reason, "overloaded", "an unmarked 503 is still the provider's")
  const over = cls(400, "overflow", { error: { code: "context_length_exceeded", message: "too big" } })
  eq(`${over.reason}/${over.learnedMaxPrompt}`, "context/4750", "a text overflow is a context overflow")
  eq(cls(400, "too_large").reason, "bad_request", "too large because of this turn's images: rejected")
  eq(cls(400, "too_large").learnedMaxPrompt, undefined, "and nothing learned")

  // The sidecar side: one quick retry when the app could not read the key; anything the platform wrote is marked.
  let calls = 0
  const rf = (inner) => R.relayFetch(inner, { prefix: "http://app/api/ingest/llm/", log: () => {}, keyId: () => "kg1", onKeyMismatch: () => {}, retryMs: 10 })
  const blip = rf(async () => (++calls === 1 ? Response.json({ error: {} }, { status: 503, headers: { "x-syrup-relay-error": "unavailable" } }) : new Response("ok", { headers: { "x-syrup-key-id": "kg1" } })))
  const r1 = await blip("http://app/api/ingest/llm/google/chat/completions", { method: "POST", body: "{}" })
  eq(`${r1.status}/${calls}`, "200/2", "a database blip is retried once")
  const crash = await rf(async () => new Response("FUNCTION_INVOCATION_FAILED", { status: 500 }))("http://app/api/ingest/llm/google/models")
  eq(crash.headers.get("x-syrup-relay-error"), "platform", "a platform 500 is marked")
  const big = await rf(async () => new Response("Request Entity Too Large", { status: 413 }))("http://app/api/ingest/llm/google/chat/completions", { method: "POST", body: "{}" })
  eq(big.headers.get("x-syrup-relay-error"), "too_large", "a platform 413 is never a learned prompt cap")
  const prov413 = await rf(async () => new Response("{}", { status: 413, headers: { "x-syrup-key-id": "kg1" } }))("http://app/api/ingest/llm/google/chat/completions", { method: "POST", body: "{}" })
  eq(prov413.headers.get("x-syrup-relay-error"), null, "the provider's own 413 stays the provider's")
  let sent = null
  await rf(async (u, init) => {
    sent = new Headers(init.headers)
    return new Response("{}", { headers: { "x-syrup-key-id": "kg1" } })
  })("http://app/api/ingest/llm/google/chat/completions", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
  eq(sent.get("x-syrup-expect-key"), "kg1", "every relay call names the key the router has on record")
  eq(sent.get("content-type"), "application/json", "the router's own headers kept")
  const unreachable = relayWith({ baseURL: { ...PROVIDER_BASE, google: "http://127.0.0.1:1/google" } })
  const ur = await record(await unreachable(mkReq("POST", { body: chatBody() }), "google", ["chat", "completions"]))
  eq(`${ur.status}/${ur.headers.get("x-syrup-relay-error")}`, "502/upstream", "provider unreachable from the app: marked upstream")
})

await scenario("16) cancellation through Next's own route pipeline (NextRequestAdapter + sendResponse): before headers and mid-stream the provider call is closed", async () => {
  const nreq = createRequire(path.join(root, "package.json"))
  const { NextRequestAdapter, signalFromNodeResponse } = nreq("next/dist/server/web/spec-extension/adapters/next-request.js")
  const { NodeNextRequest, NodeNextResponse } = nreq("next/dist/server/base-http/node.js")
  const { sendResponse } = nreq("next/dist/server/send-response.js")
  const relay = relayWith()
  // What app-route.js does for a route handler: the request's signal fires when the Node response closes early.
  const server = http.createServer(async (req, res) => {
    const nreqN = new NodeNextRequest(req)
    const nresN = new NodeNextResponse(res)
    const nextReq = NextRequestAdapter.fromNodeNextRequest(nreqN, signalFromNodeResponse(res))
    const [provider, ...rest] = new URL(req.url, "http://x").pathname.slice("/api/ingest/llm/".length).split("/")
    await sendResponse(nreqN, nresN, await relay(nextReq, provider, rest))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${server.address().port}/api/ingest/llm/google/chat/completions`
  try {
    // (a) before the provider answered.
    prov.set("google", hang())
    const ac = new AbortController()
    const p = fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" }, body: chatBody(), signal: ac.signal }).catch(() => null)
    await waitFor(() => prov.hits.length === 1, 2000, "provider reached")
    const t0 = performance.now()
    ac.abort()
    await p
    await waitFor(() => prov.hits[0].closed, 1000, "provider socket closed after the client left before headers")
    assert(prov.hits[0].closedAt - t0 < 1000, "within 1 s")
    // (b) mid-stream.
    prov.set("google", ticking(50))
    const ac2 = new AbortController()
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" }, body: chatBody(), signal: ac2.signal })
    const rd = res.body.getReader()
    await rd.read()
    await rd.read()
    const t1 = performance.now()
    ac2.abort()
    await waitFor(() => prov.hits[1]?.closed, 1000, "provider socket closed after the client left mid-stream")
    assert(prov.hits[1].closedAt - t1 < 1000, "within 1 s")
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})

await scenario("17) over the size cap: older images give way to a note, this turn's images never; text that cannot fit is a context overflow", async () => {
  const img = (n) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(n)}` } })
  const body = (msgs) => JSON.stringify({ model: "m", messages: msgs })
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "first" }, img(40_000)] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "text", text: "second" }, img(40_000)] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "text", text: "now" }, img(30_000)] },
  ]
  const fit = R.fitBody(body(msgs), 80_000)
  assert(fit.ok, "fits")
  eq(fit.removed, 1, "only as many images as needed, oldest first")
  const out = JSON.parse(fit.text)
  eq(out.messages[1].content[1].text, R.IMAGE_DROPPED, "the oldest image became a note")
  eq(out.messages[3].content[1].type, "image_url", "the next one stayed")
  eq(out.messages[5].content[1].type, "image_url", "this turn's image stayed")
  const latest = R.fitBody(body([{ role: "user", content: [img(60_000), img(60_000)] }]), 80_000)
  eq(`${latest.ok}/${latest.why}`, "false/latest", "this turn's own images alone are over: refused, not dropped")
  const text = R.fitBody(
    body([
      { role: "user", content: "x".repeat(90_000) },
      { role: "user", content: [img(10)] },
    ]),
    80_000,
  )
  eq(`${text.ok}/${text.why}`, "false/text", "text over the cap: an overflow")
  // The finding's numbers: three screenshots read as ~3K tokens, so a context answer would have taught a ~3K prompt cap.
  const three = [
    { role: "user", content: [img(1_500_000)] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [img(1_500_000)] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [img(1_500_000)] },
  ]
  const raw = body(three)
  assert(R.estimatePromptTokens(raw.length, three).tokens < 5_000, "the router's estimate of an image-heavy body is small")
  const f3 = R.fitBody(raw, R.RELAY_MAX_BODY_BYTES)
  assert(f3.ok && f3.removed === 1, "so the oldest screenshot is dropped instead, and nothing is learned")
  // A hot sandbox's sidecar from another deploy is restarted; one that cannot be checked is left alone.
  eq(R.sidecarStale({ exitCode: 0, stdout: '{"ok":true,"bundle":"h1"}' }, "h1"), false, "same bundle: kept")
  eq(R.sidecarStale({ exitCode: 0, stdout: '{"ok":true}' }, "h1"), true, "a sidecar from before bundles were reported: restarted")
  eq(R.sidecarStale({ exitCode: 0, stdout: '{"ok":true,"bundle":"h0"}' }, "h1"), true, "another bundle: restarted")
  eq(R.sidecarStale({ exitCode: 7, stdout: "" }, "h1"), true, "nothing answering on its port: restarted")
  eq(R.sidecarStale(null, "h1"), false, "the check itself failed: left alone")
})

await scenario("11) nothing key-shaped in any relay answer, header or log row", async () => {
  const all = [...seen, ...app.sent, JSON.stringify(relayLogs), JSON.stringify(app.relayLogs)].join("\n")
  eq(leaked(all).join(","), "", "no provider secret leaked")
  assert(seen.length > 40 && app.sent.length > 10, `checked a real sample (${seen.length} answers, ${app.sent.length} app writes)`)
})

// ------------------------------------------------------------------ end to end: sidecar router → mock app (relay) → mock providers

function M(id, o = {}) {
  return {
    id,
    name: o.name ?? id,
    release_date: "2026-07-01",
    status: "active",
    capabilities: { toolcall: true, reasoning: true, attachment: !!o.image, input: { text: true, image: !!o.image }, interleaved: o.interleaved ?? false },
    cost: { input: 0, output: 0 },
    limit: { context: o.context ?? 1_048_576, output: o.output ?? 65_536 },
  }
}
const engine = http.createServer((req, res) => {
  if (req.url.startsWith("/provider")) {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(
      JSON.stringify({
        all: [
          { id: "google", models: { "gemini-3.8-flash": M("gemini-3.8-flash", { image: true }), "gemini-3.5-flash-lite": M("gemini-3.5-flash-lite", { image: true }) } },
          { id: "nvidia", models: { "moonshotai/kimi-k3": M("moonshotai/kimi-k3", { image: true, output: 131_072, interleaved: { field: "reasoning_content" } }) } },
        ],
      }),
    )
  }
  if (req.url.startsWith("/global/event")) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(": hi\n\n")
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => engine.listen(0, "127.0.0.1", r))
const engineUrl = `http://127.0.0.1:${engine.address().port}`

const TIMING = { minDeadlineMs: 800, maxDeadlineMs: 1500, lastDeadlineMs: 3000, budgetMs: 8000, idleMs: 2000, nonStreamMs: 5000, hedgeMinMs: 300, hedgeMaxMs: 400, leashMs: 500 }
const SC_SECRET = "sidecar-secret"
const e2eDb = { google: { id: "kg1", secret: SECRETS.google, tier: "free" }, nvidia: { id: "kn1", secret: SECRETS.nvidia, tier: "free" } }

const originalFetch = globalThis.fetch
const rfOpts = { prefix: `${app.url}/api/ingest/llm/`, gzip: false, maxBodyBytes: undefined, log: () => {}, keyId: () => undefined, onKeyMismatch: () => {} }
let e2e = null

async function startE2e() {
  db.u1 = structuredClone(e2eDb)
  cache = newCache()
  prov.serve("google", ["gemini-3.8-flash", "gemini-3.5-flash-lite"])
  prov.serve("nvidia", ["moonshotai/kimi-k3"])
  const logs = []
  const log = (source, event, data, opts) => {
    logs.push({ source, event, data, opts })
    if (DEBUG) console.log(`  [${source}] ${event}`, JSON.stringify(data))
  }
  const cfg = { port: 0, secret: SC_SECRET, keyMeta: meta("u1"), ingestUrl: app.url, ingestToken: TOK, engineUrl, engineAuth: "Basic eA==", relayGzip: false, bundle: null }
  const store = new R.HttpRouterStore(cfg, log, { keysRefreshMs: 60_000, authRefreshGapMs: 0 })
  Object.assign(rfOpts, { log, keyId: (p) => store.keyId(p), onKeyMismatch: () => void store.refreshKeys("hint") })
  globalThis.fetch = R.relayFetch(originalFetch, rfOpts)
  const clock = { offset: 0 }
  const router = R.createRouter({ store, log, secret: SC_SECRET, baseURLs: R.relayBaseURLs(cfg), timing: TIMING, now: () => Date.now() + clock.offset })
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
  return { url: `http://127.0.0.1:${server.address().port}`, store, logs, clock, server }
}

async function chat({ user = "add a README file", messages, session, stream = true } = {}) {
  const res = await originalFetch(`${e2e.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${SC_SECRET}`, "content-type": "application/json", ...(session ? { "x-session-affinity": session } : {}) },
    body: JSON.stringify({
      model: "syrup/auto",
      stream,
      max_tokens: 4000,
      messages: messages ?? [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: user },
      ],
    }),
  })
  const text = await res.text()
  let content = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const j = json(line.slice(5).trim())
    for (const ch of j?.choices ?? []) if (typeof ch.delta?.content === "string") content += ch.delta.content
  }
  return { status: res.status, headers: res.headers, text, content }
}
/** Events the router posted to the app for chats sent after `since` (an app.events length). */
const eventsSince = (n) => app.events.slice(n)

await scenario("E6) the router's warm-up fetches each key's model list through the relay, with the real key at the provider", async () => {
  prov.serve("google", ["gemini-3.8-flash", "gemini-3.5-flash-lite"])
  prov.serve("nvidia", ["moonshotai/kimi-k3"])
  e2e = await startE2e()
  await waitFor(() => prov.hits.some((h) => h.path === "/google/models") && prov.hits.some((h) => h.path === "/nvidia/models"), 5000, "model lists fetched")
  const g = prov.hits.find((h) => h.path === "/google/models")
  eq(g.method, "GET", "GET models")
  eq(g.headers.authorization, `Bearer ${SECRETS.google}`, "real key at the provider")
  eq(prov.hits.find((h) => h.path === "/nvidia/models").headers.authorization, `Bearer ${SECRETS.nvidia}`, "real nvidia key")
  assert(
    app.llm.some((l) => l.path === "/api/ingest/llm/google/models" && l.headers.authorization === `Bearer ${TOK}`),
    "the sidecar sent the ingest token to the relay",
  )
  await waitFor(() => e2e.logs.some((l) => l.event === "relay.timing" && l.data.path === "models"), 2000, "relay.timing logged")
  const t = e2e.logs.find((l) => l.event === "relay.timing" && l.data.path === "models").data
  assert(typeof t.totalToHeadersMs === "number" && typeof t.upstreamMs === "number" && typeof t.overheadMs === "number" && typeof t.cacheHit === "boolean", `relay.timing fields (${JSON.stringify(t)})`)
})

await scenario("E1) a normal streamed turn: the provider gets the real key, the event carries the key id, the token never leaves the app", async () => {
  const n = app.events.length
  const r = await chat({ user: "e1: say hello" })
  eq(r.status, 200, "status")
  assert(/^hello from (google|nvidia)\//.test(r.content), `answered (${r.content})`)
  const hit = prov.chats().at(-1)
  eq(hit.headers.authorization, `Bearer ${SECRETS[hit.provider]}`, "real key at the provider")
  await waitFor(() => eventsSince(n).some((e) => e.status === "ok"), 2000, "router event posted")
  const ev = eventsSince(n).find((e) => e.status === "ok")
  eq(ev.keyId, e2eDb[ev.providerId].id, "the event names the metadata key id")
  for (const h of prov.hits) assert(!JSON.stringify(h.headers).includes(TOK), "no provider call ever carried the ingest token")
})

await scenario("E2) a 503 on the first backend fails over invisibly, exactly as direct", async () => {
  const n = app.events.length
  prov.next(status(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }))
  const r = await chat({ user: "e2: list the files" })
  eq(r.status, 200, "the client sees an answer")
  assert(r.content.startsWith("hello from"), "content")
  await waitFor(() => eventsSince(n).some((e) => e.status === "ok"), 2000, "events")
  const fail = eventsSince(n).find((e) => e.httpStatus === 503)
  assert(fail && fail.reason === "overloaded", `the 503 is recorded as overloaded (${JSON.stringify(eventsSince(n).map((e) => [e.status, e.reason]))})`)
  assert(prov.chats().length >= 2, "two provider calls")
  e2e.clock.offset += 15 * 60_000
})

await scenario("E3) a key switched in Settings: the next call uses the new secret, and the router's metadata follows within 1 s", async () => {
  prov.set("nvidia", status(503, { error: { message: "overloaded" } }))
  eq(e2e.store.keyId("google"), "kg1", "on record before")
  db.u1.google = { id: "kg2", secret: SECRETS.google2, tier: "free" }
  cache.forget("u1")
  const r = await chat({ user: "e3: switch keys" })
  eq(r.status, 200, "status")
  const g = prov
    .chats()
    .filter((h) => h.provider === "google")
    .at(-1)
  eq(g.headers.authorization, `Bearer ${SECRETS.google2}`, "the new secret at the provider")
  await waitFor(() => e2e.store.keyId("google") === "kg2", 1000, "metadata on kg2 (key-id hint)")
  const active = await e2e.store.activeKeys()
  eq(active.get("google").id, "kg2", "activeKeys shows kg2")
  eq(active.get("google").secret, TOK, "still only the token as the secret")
  e2e.clock.offset += 15 * 60_000
})

await scenario("E4) a key removed: syrup_no_key cools that key, the turn fails over, and the provider leaves the candidates", async () => {
  const n = app.events.length
  const first = await chat({ user: "e4: start a task", session: "s-e4" })
  eq(first.status, 200, "first turn")
  const P = prov.chats().at(-1).provider
  const other = P === "google" ? "nvidia" : "google"
  delete db.u1[P]
  cache.forget("u1")
  const hitsBefore = prov.chats().filter((h) => h.provider === P).length
  const messages = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "e4: start a task" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "file contents" },
  ]
  const r = await chat({ messages, session: "s-e4" })
  eq(r.status, 200, "the turn still answers")
  assert(r.content.startsWith(`hello from ${other}/`), `failed over to ${other} (${r.content})`)
  eq(prov.chats().filter((h) => h.provider === P).length, hitsBefore, `no call reached ${P}`)
  await waitFor(() => eventsSince(n).some((e) => e.providerId === P && e.httpStatus === 401), 2000, "the 401 event")
  const ev = eventsSince(n).find((e) => e.providerId === P && e.httpStatus === 401)
  eq(ev.reason, "auth", "recorded as a rejected key")
  await waitFor(async () => !(await e2e.store.activeKeys()).has(P), 1000, `${P} dropped from the metadata`)
  const m = app.events.length
  const again = await chat({ user: "e4: another task" })
  eq(again.status, 200, "next turn")
  await waitFor(() => eventsSince(m).some((e) => e.status === "ok"), 2000, "events")
  assert(!eventsSince(m).some((e) => e.providerId === P), `${P} is not tried again`)
  db.u1 = structuredClone(e2eDb)
  cache.forget("u1")
  await e2e.store.refreshKeys("interval")
  e2e.clock.offset += 15 * 60_000
})

await scenario("E5) the hedge loser (or a timed-out first pick) has its provider connection closed through the relay", async () => {
  const n = app.events.length
  const before = prov.chats().length
  prov.next(hang())
  const r = await chat({ user: "e5: quick question" })
  eq(r.status, 200, "answered")
  const loser = prov.chats()[before]
  assert(loser && prov.chats().length >= before + 2, "the hung call and the answer are both there")
  await waitFor(() => loser.closed, 1000, "loser's provider socket closed")
  await waitFor(() => eventsSince(n).some((e) => e.reason === "hedged" || e.reason === "timeout"), 2000, "loser recorded")
  e2e.clock.offset += 15 * 60_000
})

await scenario("E7) a body too long in text for the relay: no network call, answered as a context overflow so OpenCode compacts, no cooldown", async () => {
  const n = app.events.length
  const llmBefore = app.llm.filter((l) => l.method === "POST").length
  const chatsBefore = prov.chats().length
  rfOpts.maxBodyBytes = 20_000
  let r
  try {
    r = await chat({ user: `e7: ${"y".repeat(30_000)}` })
  } finally {
    rfOpts.maxBodyBytes = undefined
  }
  eq(r.status, 400, "400")
  assert(/context_length_exceeded/.test(r.text), `the code OpenCode compacts on (${r.text.slice(0, 200)})`)
  eq(app.llm.filter((l) => l.method === "POST").length, llmBefore, "no relay call")
  eq(prov.chats().length, chatsBefore, "no provider call")
  await waitFor(() => eventsSince(n).length > 0, 2000, "events")
  assert(
    eventsSince(n).every((e) => e.reason === "context" && e.retryAt === null && e.httpStatus === 400),
    `context, no cooldown (${JSON.stringify(eventsSince(n).map((e) => [e.reason, e.retryAt]))})`,
  )
  const st = await (await originalFetch(`${e2e.url}/v1/status`, { headers: { authorization: `Bearer ${SC_SECRET}` } })).json()
  assert(!st.cooldowns.length, `no cooldowns (${JSON.stringify(st.cooldowns)})`)
  // The learned cap is the text's own size (~8K tokens here, ~1.2M at the real 4.4 MB): true for the relay, never an image count.
  const caps = st.learned.filter((l) => l.maxPrompt).map((l) => l.maxPrompt)
  assert(caps.length > 0 && caps.every((c) => c > 7_000), `learned caps reflect the text (${JSON.stringify(caps)})`)
  assert(
    e2e.logs.some((l) => l.event === "relay.too_large" && l.data.why === "text"),
    "logged",
  )
  // A new router so the next scenarios do not inherit the learned cap.
  globalThis.fetch = originalFetch
  e2e.server.closeAllConnections?.()
  e2e.server.close()
  e2e = await startE2e()
  await waitFor(() => e2e.logs.some((l) => l.event === "warmup.done"), 5000, "warm-up")
})

await scenario("E11) an image-heavy session over the relay's limit keeps working: older screenshots give way to a note, nothing is learned or cooled", async () => {
  const n = app.events.length
  const img = (n) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"B".repeat(n)}` } })
  const messages = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: [{ type: "text", text: "e11: what is on this screen" }, img(9_000)] },
    { role: "assistant", content: "a login form" },
    { role: "user", content: [{ type: "text", text: "and this one" }, img(9_000)] },
    { role: "assistant", content: "a settings page" },
    { role: "user", content: [{ type: "text", text: "and now this" }, img(9_000)] },
  ]
  rfOpts.maxBodyBytes = 25_000
  let r
  try {
    r = await chat({ messages })
  } finally {
    rfOpts.maxBodyBytes = undefined
  }
  eq(r.status, 200, "answered")
  const hit = prov.chats().at(-1)
  const parts = hit.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  eq(parts.filter((p) => p.type === "text" && p.text === R.IMAGE_DROPPED).length, 1, "the oldest screenshot became a note")
  eq(parts.filter((p) => p.type === "image_url").length, 2, "the newer ones reached the provider")
  eq(hit.body.messages.at(-1).content[1].type, "image_url", "this turn's screenshot among them")
  await waitFor(() => eventsSince(n).some((e) => e.status === "ok"), 2000, "events")
  assert(!eventsSince(n).some((e) => e.reason === "context" || e.reason === "bad_request"), "no failed attempt")
  const st = await (await originalFetch(`${e2e.url}/v1/status`, { headers: { authorization: `Bearer ${SC_SECRET}` } })).json()
  assert(!st.learned.some((l) => l.maxPrompt), "no learned prompt cap")
  assert(
    e2e.logs.some((l) => l.event === "relay.images_dropped" && l.data.removed === 1),
    "logged",
  )
  // This turn's own screenshots over the limit: a clear 400 the user can act on, not a cap learned from ~2K estimated tokens.
  const m = app.events.length
  rfOpts.maxBodyBytes = 25_000
  try {
    r = await chat({
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: [{ type: "text", text: "e11: two big ones" }, img(15_000), img(15_000)] },
      ],
    })
  } finally {
    rfOpts.maxBodyBytes = undefined
  }
  eq(r.status, 400, "refused")
  assert(/images in the latest message/.test(r.text), `says why (${r.text.slice(0, 160)})`)
  await waitFor(() => eventsSince(m).length > 0, 2000, "events")
  assert(
    eventsSince(m).every((e) => e.reason === "bad_request" && e.retryAt === null),
    `bad_request, no cooldown (${JSON.stringify(eventsSince(m).map((e) => e.reason))})`,
  )
  const st2 = await (await originalFetch(`${e2e.url}/v1/status`, { headers: { authorization: `Bearer ${SC_SECRET}` } })).json()
  assert(!st2.learned.some((l) => l.maxPrompt), "still no learned prompt cap")
  assert(!st2.cooldowns.length, `no cooldowns (${JSON.stringify(st2.cooldowns)})`)
})

await scenario("E12) the app's database down mid-session: no provider is marked unhealthy or cooled, and the next turn after it recovers answers at once", async () => {
  const n = app.events.length
  cache.forget("u1")
  dbState.fail = true
  let r
  try {
    r = await chat({ user: "e12: hello while the database is down" })
  } finally {
    dbState.fail = false
  }
  assert(r.status >= 500, `the turn fails (${r.status})`)
  await waitFor(() => eventsSince(n).length > 0, 2000, "events")
  assert(
    eventsSince(n).every((e) => e.reason === "relay" && e.retryAt === null),
    `recorded as the relay's own failure (${JSON.stringify(eventsSince(n).map((e) => [e.reason, e.retryAt]))})`,
  )
  assert(
    e2e.logs.some((l) => l.event === "relay.timing" && l.data.relayError === "unavailable"),
    "relay.timing names the relay error",
  )
  const st = await (await originalFetch(`${e2e.url}/v1/status`, { headers: { authorization: `Bearer ${SC_SECRET}` } })).json()
  assert(!st.cooldowns.length, `no cooldowns (${JSON.stringify(st.cooldowns)})`)
  const n2 = app.events.length
  const again = await chat({ user: "e12: and now" })
  eq(again.status, 200, "answers as soon as the database is back")
  await waitFor(() => eventsSince(n2).some((e) => e.status === "ok"), 2000, "its events")
  // A dead token: every provider would read as revoked; instead it is one relay error, logged once.
  const m = app.events.length
  sessions.u1.w1.live = false
  cache.forget("u1")
  const dead = await chat({ user: "e12: after the session ended" })
  sessions.u1.w1.live = true
  cache.forget("u1")
  assert(dead.status >= 400, `refused (${dead.status})`)
  await waitFor(() => eventsSince(m).length > 0, 2000, "events")
  assert(
    eventsSince(m).every((e) => e.reason === "relay" && e.retryAt === null),
    `no key cooled (${JSON.stringify(eventsSince(m).map((e) => [e.reason, e.retryAt]))})`,
  )
  assert(
    e2e.logs.some((l) => l.event === "relay.token_rejected" && l.opts?.level === "error"),
    "relay.token_rejected logged",
  )
  const st2 = await (await originalFetch(`${e2e.url}/v1/status`, { headers: { authorization: `Bearer ${SC_SECRET}` } })).json()
  assert(!st2.cooldowns.length, `still no cooldowns (${JSON.stringify(st2.cooldowns)})`)
  e2e.clock.offset += 15 * 60_000
})

await scenario("E13) a key switched while this relay instance still caches the old one: the sidecar's expected id makes it read the database, so the call and its booking agree", async () => {
  prov.set("nvidia", status(503, { error: { message: "overloaded" } }))
  cache.forget("u1")
  eq((await lookup("u1")).value.keys.get("google").id, "kg1", "this instance caches kg1")
  db.u1.google = { id: "kg2", secret: SECRETS.google2, tier: "free" }
  // The sidecar learns first (its minute poll); this instance's cache, loaded seconds ago, still holds kg1.
  await e2e.store.refreshKeys("interval")
  eq(e2e.store.keyId("google"), "kg2", "the sidecar expects kg2")
  kclk.offset += 2_000
  const n = app.events.length
  const r = await chat({ user: "e13: after a switch elsewhere" })
  eq(r.status, 200, "status")
  const g = prov
    .chats()
    .filter((h) => h.provider === "google")
    .at(-1)
  eq(g.headers.authorization, `Bearer ${SECRETS.google2}`, "the provider got kg2's secret, which the router books the call to")
  await waitFor(() => eventsSince(n).some((e) => e.status === "ok"), 2000, "events")
  eq(eventsSince(n).find((e) => e.status === "ok").keyId, "kg2", "booked to kg2")
  db.u1 = structuredClone(e2eDb)
  cache.forget("u1")
  await e2e.store.refreshKeys("interval")
  e2e.clock.offset += 15 * 60_000
})

await scenario("E8) gzip on: a large request body goes to the relay compressed and reaches the provider as the identical JSON", async () => {
  rfOpts.gzip = true
  try {
    const before = app.llm.length
    const r = await chat({ user: `e8: ${"z".repeat(100_000)}` })
    eq(r.status, 200, "status")
    const sent = app.llm.slice(before).find((l) => l.method === "POST")
    eq(sent.headers["content-encoding"], "gzip", "compressed on the way to the app")
    const hit = prov.chats().at(-1)
    eq(hit.headers["content-encoding"], undefined, "plain at the provider")
    assert(
      hit.body?.messages?.some((m) => typeof m.content === "string" && m.content.includes("z".repeat(100_000))),
      "identical JSON at the provider",
    )
    eq(hit.headers["content-length"], String(hit.raw.length), "real content-length")
  } finally {
    rfOpts.gzip = false
  }
})

await scenario("E9) the relay deadline mid-answer: the stream closes cleanly and the router records it as truncated", async () => {
  const n = app.events.length
  app.deadlineMs = 600
  prov.set("*", ticking(50))
  try {
    const r = await chat({ user: "e9: write a long essay" })
    eq(r.status, 200, "status")
    assert(r.content.includes("tick0"), "content arrived")
  } finally {
    app.deadlineMs = 290_000
  }
  await waitFor(() => eventsSince(n).some((e) => e.reason === "truncated"), 2000, "truncated event")
  assert(
    app.relayLogs.some((l) => l.event === "relay.deadline_cut"),
    "deadline cut logged by the relay",
  )
  await waitFor(() => prov.chats().at(-1).closed, 1000, "provider connection closed")
})

await scenario("E10) nothing secret ever reached the sidecar side: app answers, router logs, events", async () => {
  const all = [...app.sent, JSON.stringify(e2e.logs), JSON.stringify(app.events)].join("\n")
  eq(leaked(all).join(","), "", "no provider secret")
  globalThis.fetch = originalFetch
  e2e.server.closeAllConnections?.()
  e2e.server.close()
})

// ------------------------------------------------------------------ the bundled sidecar as a child process

await scenario("S1) the bundled sidecar runs on metadata-only env and answers through the relay", async () => {
  const dir = path.join(outDir, "sidecar")
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await build({
    entryPoints: [path.join(root, "sidecar/index.ts")],
    outfile: path.join(dir, "sidecar.js"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    banner: { js: "// syrup sidecar. Built from sidecar/index.ts; do not edit.\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: "warning",
  })
  db.u1 = structuredClone(e2eDb)
  cache = newCache()
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
  const token = R.mintIngestToken("u1", "w9", 60 * 60_000, SESSION)
  const env = { ...process.env }
  delete env.SYRUP_MASTER_KEY
  Object.assign(env, {
    SYRUP_ROUTER_KEYS: JSON.stringify(meta("u1")),
    SYRUP_INTERNAL_SECRET: SC_SECRET,
    SYRUP_INGEST_URL: app.url,
    SYRUP_INGEST_TOKEN: token,
    SYRUP_ROUTER_PORT: String(port),
    OPENCODE_SERVER_PASSWORD: "pw",
    OPENCODE_URL: engineUrl,
    SYRUP_MEMORY_INDEX: path.join(dir, "MEMORY.md").replaceAll("\\", "/"),
    SYRUP_SIDECAR_BUNDLE: "bundle-test-hash",
  })
  eq(leaked(JSON.stringify(env)).join(","), "", "no provider secret in the child's environment")
  const sentBefore = app.sent.length
  const llmBefore = app.llm.length
  const child = spawn(process.execPath, [path.join(dir, "sidecar.js")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  child.stderr.on("data", (d) => (out += d))
  try {
    await waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).ok
        } catch {
          return false
        }
      },
      15_000,
      "sidecar health",
    )
    eq((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).bundle, "bundle-test-hash", "/health names the bundle the app started (a hot sandbox from another deploy is restarted)")
    await waitFor(() => app.llm.slice(llmBefore).some((l) => l.path.endsWith("/models")), 5000, "warm-up through the relay")
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SC_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "syrup/auto",
        stream: true,
        max_tokens: 2000,
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "s1: hello from the bundle" },
        ],
      }),
    })
    eq(res.status, 200, "status")
    const text = await res.text()
    assert(/hello from (google|nvidia)\//.test(text), "streamed answer arrived")
    const calls = app.llm.slice(llmBefore)
    assert(calls.length > 0 && calls.every((l) => l.headers.authorization === `Bearer ${token}`), "every relay call used the ingest token")
    const hit = prov.chats().at(-1)
    eq(hit.headers.authorization, `Bearer ${SECRETS[hit.provider]}`, "the provider got the real key")
    await waitFor(() => app.logs.some((r) => r.event === "relay.timing"), 3000, "relay.timing shipped to /api/ingest/logs")
    eq(leaked(app.sent.slice(sentBefore).join("\n") + JSON.stringify(app.logs)).join(","), "", "nothing secret sent to the sidecar or logged by it")
  } catch (err) {
    console.log(out.slice(-3000))
    throw err
  } finally {
    child.kill()
  }
})

// ------------------------------------------------------------------ the added time to first byte, on loopback

await scenario("B1) micro-benchmark: added time to first byte of the relay hop (loopback, warm key cache)", async () => {
  app.capturing = false
  db.u1 = structuredClone(e2eDb)
  cache = newCache()
  prov.set("google", async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  const body = chatBody()
  async function ttfb(url, headers) {
    const t0 = performance.now()
    const res = await fetch(url, { method: "POST", headers, body })
    const reader = res.body.getReader()
    await reader.read()
    const t = performance.now() - t0
    while (!(await reader.read()).done);
    return t
  }
  const direct = () => ttfb(`${prov.url}/google/chat/completions`, { "content-type": "application/json", authorization: `Bearer ${SECRETS.google}` })
  const via = () => ttfb(`${app.url}/api/ingest/llm/google/chat/completions`, { "content-type": "application/json", authorization: `Bearer ${TOK}` })
  for (let i = 0; i < 30; i++) {
    await direct()
    await via()
  }
  const d = []
  const v = []
  for (let i = 0; i < 300; i++) {
    d.push(await direct())
    v.push(await via())
  }
  const f = (x) => x.toFixed(2)
  console.log(`     direct  p50 ${f(pct(d, 50))} ms  p95 ${f(pct(d, 95))} ms`)
  console.log(`     relay   p50 ${f(pct(v, 50))} ms  p95 ${f(pct(v, 95))} ms`)
  console.log(`     added   p50 ${f(pct(v, 50) - pct(d, 50))} ms  p95 ${f(pct(v, 95) - pct(d, 95))} ms  (300 sequential runs each, interleaved)`)
  assert(pct(v, 50) - pct(d, 50) < 15, "added p50 under 15 ms on loopback")
  // The other cache paths: served stale (refreshed in the background) and a miss that waits for a 20 ms database.
  const stale = []
  const miss = []
  dbState.delayMs = 20
  try {
    for (let i = 0; i < 60; i++) {
      kclk.offset += 11_000
      stale.push(await via())
      await sleep(30)
      cache.forget("u1")
      miss.push(await via())
    }
  } finally {
    dbState.delayMs = 0
  }
  console.log(`     stale   p50 ${f(pct(stale, 50))} ms  p95 ${f(pct(stale, 95))} ms  (served at once, refreshed in the background)`)
  console.log(`     miss    p50 ${f(pct(miss, 50))} ms  p95 ${f(pct(miss, 95))} ms  (waits for a 20 ms database read)`)
  assert(pct(stale, 50) - pct(v, 50) < 5, "a stale hit costs no more than a fresh one (under 5 ms more at p50)")
  assert(pct(miss, 50) >= 20 && pct(miss, 50) - pct(v, 50) < 40, "a miss costs the database read and little else")
  app.capturing = true
})

// ------------------------------------------------------------------ summary

for (const s of [prov.server, appServer, engine]) {
  s.closeAllConnections?.()
  s.close()
}
const failedCount = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failedCount}/${results.length} scenarios passed`)
process.exit(failedCount ? 1 : 0)
