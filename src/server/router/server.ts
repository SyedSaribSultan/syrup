import crypto from "node:crypto"
import http from "node:http"
import { db, dbReady, schema } from "../db"
import { env } from "../env"
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

async function log(row: typeof schema.routerEvents.$inferInsert) {
  try {
    await dbReady()
    await db().insert(schema.routerEvents).values(row)
  } catch (err) {
    console.warn("[syrup] router: could not log", err)
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
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

/** Pull `usage` out of an SSE stream as it passes through. */
function usageTap(onUsage: (u: Usage) => void): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder()
  let buf = ""
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
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
        } catch {}
      }
    },
  })
}

async function chatCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
  const started = Date.now()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return json(res, 400, { error: { message: "Invalid JSON body" } })
  }

  const requested = String(body.model ?? "auto").replace(/^syrup\//, "")
  const alias: Alias = requested in ALIASES ? (requested as Alias) : "auto"
  const stream = body.stream === true
  if (stream) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true }

  const list = (await candidates(alias)).filter((c) => (cooldown.get(coolKey(c)) ?? 0) < Date.now())
  if (list.length === 0) {
    return json(res, 503, {
      error: {
        type: "syrup_no_backend",
        message: "syrup router: no connected provider can serve this request. Add an API key under Providers, or pick a model directly.",
      },
    })
  }

  const errors: string[] = []
  let attempt = 0
  for (const c of list) {
    attempt++
    if (attempt > 4) break
    const abort = new AbortController()
    req.on("close", () => abort.abort())
    let upstream: Response
    try {
      upstream = await fetch(`${c.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${c.apiKey}`,
          ...(c.providerID === "openrouter" ? { "http-referer": "https://github.com/SyedSaribSultan/syrup", "x-title": "syrup" } : {}),
        },
        body: JSON.stringify({ ...body, model: c.modelID }),
        signal: abort.signal,
      })
    } catch (err) {
      if (abort.signal.aborted) return
      errors.push(`${c.providerID}/${c.modelID}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    if (upstream.status === 429 || upstream.status >= 500) {
      const wait = upstream.status === 429 ? retryAfterMs(upstream) : 15_000
      cooldown.set(coolKey(c), Date.now() + wait)
      const text = await upstream.text().catch(() => "")
      errors.push(`${c.providerID}/${c.modelID}: ${upstream.status} ${text.slice(0, 200)}`)
      void log({
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
    const finish = (status: string) =>
      void log({
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
        latencyMs: Date.now() - started,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cost: costOf(c, usage),
      })

    const headers: Record<string, string> = {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-syrup-provider": c.providerID,
      "x-syrup-model": c.modelID,
      "x-syrup-attempts": String(attempt),
    }
    if (stream) headers["cache-control"] = "no-cache"
    res.writeHead(upstream.status, headers)

    if (!upstream.body) {
      res.end()
      finish(upstream.ok ? "ok" : "error")
      return
    }

    if (!stream || !upstream.ok) {
      const text = await upstream.text()
      try {
        usage = JSON.parse(text).usage ?? {}
      } catch {}
      res.end(text)
      finish(upstream.ok ? "ok" : "error")
      return
    }

    const tapped = upstream.body.pipeThrough(usageTap((u) => (usage = u)))
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
      finish(abort.signal.aborted ? "aborted" : "error")
      void err
    }
    return
  }

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
        if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true })
        json(res, 404, { error: { message: `syrup router: no route ${req.method} ${url.pathname}` } })
      })
      server.on("error", (err) => {
        g.__syrupRouter = undefined
        reject(err)
      })
      server.listen(env.routerPort, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${env.routerPort}/v1`
        console.log(`[syrup] router at ${url}`)
        resolve(url)
      })
    })
  }
  return g.__syrupRouter
}
