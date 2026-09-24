import http from "node:http"
import { createRouter, json } from "../src/server/router/core"
import { handleMemoryMcp } from "../src/server/memory/tools"
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
const memory = new HttpMemoryStore(cfg)

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
    void log.flush().finally(() => process.exit(0))
  })
}
