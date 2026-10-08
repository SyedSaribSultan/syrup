/**
 * The eval's own syrup (`pnpm eval`, scripts/eval.mjs bundles and starts this file): syrup's real
 * server modules (engine/opencode.ts with its config, plugin and config-dir preparation, the router,
 * the local vault, the memory MCP) in a plain Node process, without Next.js. It never touches the
 * dev server, its ports, its database or its engine.
 *
 * It answers the few routes scripts/lib/drive.mjs and the runner call, in the app's shapes:
 *   GET  /api/health                              { ok, engine }
 *   ANY  /api/oc/<engine path>                    passed through to its OpenCode (with the engine password), streamed
 *   GET  /api/router/answers?session=             { answers } (src/server/router-status.ts)
 *   GET  /api/eval/transcript?session=&directory= syrup.transcript v1 JSON (src/lib/transcript.ts), secrets redacted
 *
 * Its environment comes from the runner: its own ports, SYRUP_HOME, SYRUP_DB and XDG folders for the
 * engine; SYRUP_EVAL=1 (the router keeps eval traffic off scarce backends) and SYRUP_EVAL_REPLAY
 * (the plugin answers web tools from a cassette); and, read-only, where the user's vault is
 * (SYRUP_KEYS_DB, SYRUP_VAULT_HOME), so real keys reach real models without being copied anywhere.
 */
import http from "node:http"
import os from "node:os"
import { buildTranscript, renderJSON, type RawMessage } from "../../src/lib/transcript"
import { engine, engineAuthHeader } from "../../src/server/engine/opencode"
import { env } from "../../src/server/env"
import { localSessionAnswers } from "../../src/server/router-status"
import { LocalRouterStore } from "../../src/server/router/store-local"

const PORT = Number(process.env.SYRUP_EVAL_HOST_PORT)
if (!PORT) throw new Error("SYRUP_EVAL_HOST_PORT is not set")

const t0 = Date.now()
const e = await engine()
const engineUrl = new URL(e.url)
console.log(`[eval-host] engine ready at ${e.url} in ${Date.now() - t0} ms`)

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" })
  res.end(typeof body === "string" ? body : JSON.stringify(body))
}

/** Streams a request through to the engine; the event stream stays open and unbuffered. */
function proxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const target = `${url.pathname.slice("/api/oc".length) || "/"}${url.search}`
  const headers = { ...req.headers, host: engineUrl.host, authorization: engineAuthHeader() }
  const up = http.request({ hostname: engineUrl.hostname, port: engineUrl.port, method: req.method, path: target, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers)
    r.pipe(res)
  })
  up.on("error", (err) => {
    if (!res.headersSent) send(res, 502, { error: String(err) })
    else res.end()
  })
  res.on("close", () => up.destroy())
  req.pipe(up)
}

/** Every secret this process knows, for redaction: the engine password and router bearer, and each active key. */
async function secrets(): Promise<string[]> {
  const keys = await new LocalRouterStore().activeKeys().catch(() => new Map())
  return [env.internalSecret, ...[...keys.values()].map((k) => k.secret)].filter((s) => s && s.length >= 8)
}

async function transcript(sessionId: string, directory: string): Promise<string> {
  const [sess, msgs, answers, hidden] = await Promise.all([
    e.client.session.get({ path: { id: sessionId }, query: { directory } }),
    e.client.session.messages({ path: { id: sessionId }, query: { directory } }),
    localSessionAnswers(sessionId),
    secrets(),
  ])
  if (!sess.data || !msgs.data) throw new Error("the engine did not return this chat")
  const t = buildTranscript({
    title: sess.data.title,
    messages: msgs.data as unknown as RawMessage[],
    answers,
    createdAt: sess.data.time.created,
    updatedAt: sess.data.time.updated,
    paths: { roots: [directory], homes: [os.homedir()] },
    secrets: { secrets: hidden },
  })
  return renderJSON(t)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === "/api/health") return send(res, 200, { ok: true, engine: e.url })
  if (url.pathname.startsWith("/api/oc/")) return proxy(req, res, url)
  if (url.pathname === "/api/router/answers") {
    const session = url.searchParams.get("session") ?? ""
    if (!session) return send(res, 400, { error: "session is required" })
    localSessionAnswers(session).then(
      (answers) => send(res, 200, { answers }),
      (err) => send(res, 500, { error: String(err) }),
    )
    return
  }
  if (url.pathname === "/api/eval/transcript") {
    const session = url.searchParams.get("session") ?? ""
    const directory = url.searchParams.get("directory") ?? ""
    transcript(session, directory).then(
      (json) => send(res, 200, json),
      (err) => send(res, 500, { error: String(err) }),
    )
    return
  }
  send(res, 404, { error: `eval host: no route ${req.method} ${url.pathname}` })
})

server.listen(PORT, "127.0.0.1", () => console.log(`[eval-host] listening on http://127.0.0.1:${PORT}`))

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    e.close()
    process.exit(0)
  })
