import { mkdirSync, writeFileSync } from "node:fs"
import http from "node:http"
import { renderMemoryIndex } from "../src/server/cloud/memory"
import { handleMemoryMcp, type MemoryStore } from "../src/server/memory/tools"
import { createRouter, json } from "../src/server/router/core"
import { startEventTap } from "./events"
import { HttpLog } from "./log-http"
import { relayFetch } from "./relay-fetch"
import { HttpMemoryStore, HttpRouterStore, readSidecarEnv, relayBaseURLs } from "./store-http"

/**
 * syrup sidecar: runs inside the workspace sandbox next to OpenCode.
 * One loopback HTTP server with the router (/v1) and the memory MCP (/mcp),
 * both guarded by SYRUP_INTERNAL_SECRET.
 *
 * No provider key ever reaches this process. It knows which keys the user has
 * (id and tier, from SYRUP_ROUTER_KEYS, refreshed from the app while it runs),
 * and the router reaches every provider through the app's LLM relay at
 * SYRUP_INGEST_URL/api/ingest/llm/<provider>, which adds the real key per call.
 * Everything it learns is posted to the syrup app at SYRUP_INGEST_URL.
 *
 * Bundled by sidecar/build.mjs into a single file; no node_modules in the VM.
 */

const cfg = readSidecarEnv()
const log = new HttpLog(cfg)
// Nothing restarts the sidecar inside a running sandbox, so a stray rejection must not take routing and memory down with it.
process.on("unhandledRejection", (err) => log.fn("sidecar", "unhandled_rejection", err, { level: "error" }))
const store = new HttpRouterStore(cfg, log.fn)
// Installed before the router exists: its warm-up already fetches every key's model list through the relay.
globalThis.fetch = relayFetch(globalThis.fetch, {
  prefix: `${cfg.ingestUrl}/api/ingest/llm/`,
  gzip: cfg.relayGzip,
  log: log.fn,
  keyId: (providerId) => store.keyId(providerId),
  onKeyMismatch: () => void store.refreshKeys("hint"),
})
const router = createRouter({ store, log: log.fn, secret: cfg.secret, baseURLs: relayBaseURLs(cfg) })

/** MEMORY.md that OpenCode loads as instructions (engine/sandbox.ts engineConfig). Rewritten after every change. */
const INDEX_PATH = process.env.SYRUP_MEMORY_INDEX ?? "/vercel/.syrup/MEMORY.md"
/** How often to ask the syrup app whether the user's memories changed elsewhere (the Memory page, another workspace). */
const INDEX_POLL_MS = Number(process.env.SYRUP_MEMORY_POLL_MS ?? 30_000)

/**
 * Memory store that keeps the on-disk index in step with the remote store:
 * rewritten after the agent's own changes, and whenever the app's cheap
 * version stamp moves because memories changed outside this sandbox.
 */
class IndexedMemoryStore implements MemoryStore {
  private seen: string | undefined
  private wrote = false
  private pollFailing = false
  constructor(private inner: HttpMemoryStore) {}
  async writeIndex() {
    let rows: Awaited<ReturnType<MemoryStore["list"]>> = []
    try {
      rows = await this.inner.list(150)
    } catch (err) {
      log.fn("sidecar", "memory_index.failed", err, { level: "warn" })
      if (this.wrote) return
    }
    mkdirSync(INDEX_PATH.slice(0, INDEX_PATH.lastIndexOf("/")), { recursive: true })
    writeFileSync(INDEX_PATH, renderMemoryIndex(rows), "utf8")
    this.wrote = true
  }
  /** Rewrites the index when the version stamp moved. At start it always writes, so OpenCode has a file to load. */
  async refresh(start = false) {
    let v: string | undefined
    try {
      v = await this.inner.version()
      this.pollFailing = false
    } catch (err) {
      if (!this.pollFailing) log.fn("sidecar", "memory_version.failed", err, { level: "warn" })
      this.pollFailing = true
      if (!start) return
    }
    if (!start && v === this.seen) return
    await this.writeIndex()
    if (v !== undefined) this.seen = v
  }
  watch(ms: number) {
    setInterval(() => void this.refresh(), ms).unref()
  }
  search = (q: string, limit: number) => this.inner.search(q, limit)
  list = (limit: number) => this.inner.list(limit)
  get = (id: string) => this.inner.get(id)
  async save(input: Parameters<MemoryStore["save"]>[0]) {
    const r = await this.inner.save(input)
    void this.writeIndex()
    return r
  }
  async update(id: string, patch: Parameters<MemoryStore["update"]>[1]) {
    const r = await this.inner.update(id, patch)
    void this.writeIndex()
    return r
  }
  async delete(id: string) {
    await this.inner.delete(id)
    void this.writeIndex()
  }
}

const memory = new IndexedMemoryStore(new HttpMemoryStore(cfg))
await memory.refresh(true)
memory.watch(INDEX_POLL_MS)
const tap = startEventTap(cfg, log.fn)

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  // Which build is running: the app restarts a reused sandbox whose sidecar is not this deploy's (engine/sidecar-version.ts).
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, bundle: cfg.bundle })
  router
    .handle(req, res, url)
    .then((handled) => {
      if (handled) return
      if (url.pathname === "/mcp")
        return handleMemoryMcp(req, res, memory, log.fn, cfg.secret).catch((err) => {
          log.fn("mcp", "transport.error", err, { level: "error" })
          if (!res.headersSent) json(res, 500, { error: { message: String(err) } })
          else res.end()
        })
      json(res, 404, { error: { message: `sidecar: no route ${req.method} ${url.pathname}` } })
    })
    .catch((err) => {
      log.fn("router", "request.crashed", err, { level: "error" })
      if (!res.headersSent) json(res, 500, { error: { message: "sidecar: internal error" } })
      else res.end()
    })
})

server.listen(cfg.port, "127.0.0.1", () => {
  log.fn("sidecar", "listening", { port: cfg.port, providers: Object.keys(cfg.keyMeta), ingest: cfg.ingestUrl, relayGzip: cfg.relayGzip })
  console.log(`[sidecar] listening on 127.0.0.1:${cfg.port}`)
})

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.fn("sidecar", "stopping", { signal: sig })
    void Promise.all([tap.flush(), log.flush()]).finally(() => process.exit(0))
  })
}
