import { mkdirSync, writeFileSync } from "node:fs"
import http from "node:http"
import { renderMemoryIndex } from "../src/server/cloud/memory"
import { handleMemoryMcp, type MemoryStore } from "../src/server/memory/tools"
import { createRouter, json } from "../src/server/router/core"
import { startEventTap } from "./events"
import { HttpLog } from "./log-http"
import { HttpMemoryStore, HttpRouterStore, readSidecarEnv } from "./store-http"

/**
 * syrup sidecar: runs inside the workspace sandbox next to OpenCode.
 * One loopback HTTP server with the router (/v1) and the memory MCP (/mcp),
 * both guarded by SYRUP_INTERNAL_SECRET. Keys arrive in process env only.
 * Everything it learns is posted to the syrup app at SYRUP_INGEST_URL.
 *
 * Bundled by sidecar/build.mjs into a single file; no node_modules in the VM.
 */

const cfg = readSidecarEnv()
const log = new HttpLog(cfg)
const router = createRouter({ store: new HttpRouterStore(cfg, log.fn), log: log.fn, secret: cfg.secret })

/** MEMORY.md that OpenCode loads as instructions (engine/sandbox.ts engineConfig). Rewritten after every change. */
const INDEX_PATH = process.env.SYRUP_MEMORY_INDEX ?? "/vercel/.syrup/MEMORY.md"

/** Memory store that keeps the on-disk index in step with the remote store. */
class IndexedMemoryStore implements MemoryStore {
  constructor(private inner: MemoryStore) {}
  async writeIndex() {
    let rows: Awaited<ReturnType<MemoryStore["list"]>> = []
    try {
      rows = await this.inner.list(150)
    } catch (err) {
      log.fn("sidecar", "memory_index.failed", err, { level: "warn" })
    }
    mkdirSync(INDEX_PATH.slice(0, INDEX_PATH.lastIndexOf("/")), { recursive: true })
    writeFileSync(INDEX_PATH, renderMemoryIndex(rows), "utf8")
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
await memory.writeIndex()
const tap = startEventTap(cfg, log.fn)

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  void router.handle(req, res, url).then((handled) => {
    if (handled) return
    if (url.pathname === "/mcp")
      return handleMemoryMcp(req, res, memory, log.fn, cfg.secret).catch((err) => {
        log.fn("mcp", "transport.error", err, { level: "error" })
        if (!res.headersSent) json(res, 500, { error: { message: String(err) } })
        else res.end()
      })
    json(res, 404, { error: { message: `sidecar: no route ${req.method} ${url.pathname}` } })
  })
})

server.listen(cfg.port, "127.0.0.1", () => {
  log.fn("sidecar", "listening", { port: cfg.port, providers: Object.keys(cfg.keys), ingest: cfg.ingestUrl })
  console.log(`[sidecar] listening on 127.0.0.1:${cfg.port}`)
})

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.fn("sidecar", "stopping", { signal: sig })
    void Promise.all([tap.flush(), log.flush()]).finally(() => process.exit(0))
  })
}
