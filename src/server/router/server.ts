import http from "node:http"
import { env } from "../env"
import { slog } from "../log"
import { handleMcp } from "../mcp"
import { createRouter, json } from "./core"
import { LocalRouterStore } from "./store-local"

/**
 * Local-mode router process: the OpenAI-compatible /v1 endpoint plus the
 * memory MCP server, on one loopback port, both guarded by the per-process
 * secret the engine was given. The routing logic itself lives in core.ts and
 * is shared with the sandbox sidecar.
 */

const g = globalThis as unknown as { __syrupRouter?: Promise<string> }

/** Starts the router once per process and resolves to its base URL (…/v1). */
export function startRouter(): Promise<string> {
  if (!g.__syrupRouter) {
    g.__syrupRouter = new Promise((resolve, reject) => {
      const router = createRouter({ store: new LocalRouterStore(), log: slog, secret: env.internalSecret })
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        void router.handle(req, res, url).then((handled) => {
          if (handled) return
          if (url.pathname === "/mcp")
            return handleMcp(req, res, env.internalSecret).catch((err) => {
              slog("mcp", "transport.error", err, { level: "error" })
              if (!res.headersSent) json(res, 500, { error: { message: String(err) } })
              else res.end()
            })
          slog("router", "request.unknown_route", { method: req.method, path: url.pathname }, { level: "warn" })
          json(res, 404, { error: { message: `syrup router: no route ${req.method} ${url.pathname}` } })
        })
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
