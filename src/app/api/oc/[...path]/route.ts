import fs from "node:fs"
import { CREDENTIALS_REFUSED, isLocalDrivePath, NOT_LOCAL_DRIVE, reachesCredentials } from "@/server/credential-dirs"
import { engine, engineAuthHeader } from "@/server/engine/opencode"
import { proxyRequestHeaders, proxyResponseHeaders } from "@/server/local-guard"
import { ensureSarib } from "@/server/sarib"
import { revokeLocalSessionShares } from "@/server/shares"

/**
 * Proxy to the embedded OpenCode server (local mode). The browser uses the typed OpenCode SDK pointed at /api/oc, so
 * the engine routes the UI needs (sessions, the event stream, permissions, questions, the file list) are available
 * without re-wrapping them. Only those routes pass (ROUTES); a path is checked exactly as the engine will route it
 * (plain segments, compared without case); no request may name the engine's or syrup's own settings folders as its
 * directory (where the provider keys and the vault key live); and the answers that carry secrets are scrubbed.
 */

export const dynamic = "force-dynamic"

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const engineError = (status: number, name: string, message: string) => Response.json({ name, data: { message } }, { status })

/** OpenCode 1.18's own second decode of a query `directory` (its instance middleware): decodeURIComponent, or the value as is when that throws. */
function engineDecode(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

/**
 * One path segment as the UI sends them: route names and engine ids. Next hands the route its segments decoded, so
 * anything else (a space, a control character, ";", "\", or an encoded "/", "?" or "#") could reach a different engine
 * route than the one checked here (the engine ignores a trailing space or ";x", and "\" or "?" change the URL itself).
 */
const SEGMENT = /^[A-Za-z0-9._~:@=+,-]+$/

/**
 * Engine routes the browser may reach, by method, lowercase (the engine matches routes without regard to case): the
 * ones the UI calls (src/lib/engine-store.tsx, workspace-fs.ts, workspaces.tsx) and scripts/bench-agent.mjs, plus
 * the redacted config reads. Everything else is refused: the engine's v2 API (api/…), the shell, PTY, file search,
 * global, auth and config writes among it, some of which read or run anything on the machine. A feature that needs
 * another engine route adds it here. Local mode reads files through /api/workspace/files, so file/content is not here.
 */
const ROUTES: [method: string, route: RegExp][] = [
  ["GET", /^(event|path|project|config|config\/providers|provider|agent|permission|question|file)$/],
  ["GET", /^session(\/[^/]+(\/(message(\/[^/]+)?|todo|diff|children))?)?$/],
  ["POST", /^session$/],
  ["POST", /^session\/[^/]+\/(prompt_async|message|abort|permissions\/[^/]+)$/],
  ["PATCH", /^session\/[^/]+$/],
  ["DELETE", /^session\/[^/]+$/],
  ["POST", /^permission\/[^/]+\/reply$/],
  ["POST", /^question\/[^/]+\/(reply|reject)$/],
]

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  if (!path.length || path.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return engineError(400, "BadRequest", "That is not an engine route.")
  // Every check below and the engine see the same route.
  const route = path.join("/").toLowerCase()
  const method = req.method === "HEAD" ? "GET" : req.method
  if (!ROUTES.some(([m, r]) => m === method && r.test(route))) return engineError(404, "NotFoundError", `syrup doesn't pass ${method} /${route} to the engine.`)

  const incoming = new URL(req.url)
  const dir = incoming.searchParams.get("directory")
  // The SDK names the folder in a header on POST requests, in the query on GET.
  let headerDir: string | null = null
  try {
    headerDir = req.headers.get("x-opencode-directory") ? decodeURIComponent(req.headers.get("x-opencode-directory")!) : null
  } catch {
    return engineError(400, "BadRequest", "The workspace folder is not readable.")
  }
  // Every value of a repeated parameter, whichever one the engine reads.
  const queryDirs = incoming.searchParams.getAll("directory")
  // OpenCode decodes a query `directory` once more after the URL parser has (engineDecode), so "x%41" opens "xA" and
  // "a\%2e%2e\b" climbs out of a. A value the engine would read differently from the one checked here is refused.
  if (queryDirs.some((d) => engineDecode(d) !== d)) return engineError(400, "BadRequest", "syrup can't pass a folder whose name contains % and two hex digits to the engine. Rename it and pick it again.")
  const dirs = [...queryDirs, ...(headerDir ? [headerDir] : [])]
  // Windows: drive-letter paths only. \\127.0.0.1\c$\… is this same disk under a name the checks below can't match.
  if (dirs.some((d) => !isLocalDrivePath(d))) return engineError(400, "BadRequest", NOT_LOCAL_DRIVE)
  // Credential folders (src/server/credential-dirs.ts): the engine's auth.json, syrup's vault key.
  const refused = () => engineError(403, "ForbiddenError", CREDENTIALS_REFUSED)
  if (dirs.some((d) => reachesCredentials(d))) return refused()
  // The file list names a folder inside the workspace, which can be a parent of those (a workspace in your home
  // folder). Checked as sent and as decoded once more, whichever the engine uses.
  const paths = incoming.searchParams.getAll("path").flatMap((p) => [p, engineDecode(p)])
  if (route === "file" && dirs.some((d) => paths.some((p) => reachesCredentials(d, p)))) return refused()
  // A workspace folder that was moved or deleted: the engine would accept the session and then fail the first
  // prompt with a bare "Unexpected server error", so answer here in the engine's own error shape.
  if (dir && !isDirectory(dir)) {
    return Response.json({ name: "NotFoundError", data: { message: `The folder ${dir} no longer exists. Pick another workspace, or put the folder back and reload.` } }, { status: 404 })
  }
  const { url: base } = await engine()
  const target = new URL(`${base}/${path.join("/")}`)
  target.search = incoming.search

  // Give workspaces with .sarib files the sarib tools. Before a prompt it is
  // awaited (bounded) so the turn already sees them; otherwise it runs in the background.
  if (dir) {
    const ready = ensureSarib(dir)
    if (req.method === "POST" && /^session\/[^/]+\/(prompt_async|message)$/.test(route)) {
      await Promise.race([ready, new Promise((r) => setTimeout(r, 5_000))])
    }
  }

  // No origin, referer or cookie reaches the engine; the engine's password replaces any client authorization.
  const headers = proxyRequestHeaders(req.headers, engineAuthHeader())

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    duplex: "half",
    // SSE streams must not be buffered or cached.
    cache: "no-store",
    signal: req.signal,
  }

  const upstream = await fetch(target, init)
  // Deleting a chat takes its share links down too.
  // The session id keeps its own spelling (ids are case-sensitive); only the route name is compared without case.
  const deleted = req.method === "DELETE" && upstream.ok && /^session\/[^/]+$/.test(route) ? path[1] : undefined
  if (deleted) await revokeLocalSessionShares(deleted).catch(() => {})
  // Without content-encoding, content-length or any access-control-* grant (both branches below use `out`).
  const out = proxyResponseHeaders(upstream.headers)
  // The few JSON answers that carry secrets are rewritten; everything else (the event stream above all) streams through.
  const redact = REDACT[route]
  if (redact && upstream.ok && /\bjson\b/i.test(upstream.headers.get("content-type") ?? "")) {
    let body: unknown
    try {
      body = await upstream.json()
    } catch {
      return Response.json({ name: "UnknownError", data: { message: "The engine sent an unreadable answer." } }, { status: 502 })
    }
    return new Response(JSON.stringify(redact(body)), { status: upstream.status, headers: out })
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

// ---- Keeping secrets out of the browser ----
// The engine answers with what it holds: provider API keys (providers[].key, from the user's saved keys or the
// environment), the router's shared secret (provider.syrup.options.apiKey, which in local mode is also the engine's
// own password) and the memory MCP's authorization header. The UI reads none of them (it needs provider ids, names
// and models), so they are dropped here, by name, on the endpoints that return engine or provider config.

/** Field names that hold a credential, compared without case, "-" or "_". */
const SECRET_NAMES = new Set(["key", "apikey", "xapikey", "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "bearer", "secret", "clientsecret", "password", "passwd", "authorization", "proxyauthorization", "cookie", "privatekey", "access", "refresh", "credentials"])
const isSecretName = (k: string) => SECRET_NAMES.has(k.toLowerCase().replace(/[-_]/g, ""))
/** Objects whose every value can be a credential (HTTP headers, a server's environment): emptied whole. */
const OPAQUE = new Set(["headers", "environment", "env"])

/** A URL without a password in it or credential-looking query parameters. */
function scrubUrl(v: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v
  try {
    const u = new URL(v)
    let changed = false
    if (u.username || u.password) {
      u.username = ""
      u.password = ""
      changed = true
    }
    for (const k of [...u.searchParams.keys()]) {
      if (isSecretName(k) || /key|token|secret|sig/i.test(k)) {
        u.searchParams.delete(k)
        changed = true
      }
    }
    return changed ? u.toString() : v
  } catch {
    return v
  }
}

/** Removes secret-named fields at any depth, empties header/env maps and scrubs URLs. Arrays of names (a provider's `env` list) stay. */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub)
  if (typeof v === "string") return scrubUrl(v)
  if (!v || typeof v !== "object") return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    if (isSecretName(k)) continue
    if (OPAQUE.has(k) && x && typeof x === "object" && !Array.isArray(x)) out[k] = {}
    else out[k] = scrub(x)
  }
  return out
}

/**
 * One provider ({ id, name, env: [names], key, options, models }): `key` and secret-named options go, `headers` maps
 * are emptied. Model ids are kept as they are, whatever they are called; only what is inside each model is scrubbed.
 */
function scrubProvider(p: unknown): unknown {
  if (!p || typeof p !== "object" || Array.isArray(p)) return p
  const { models, ...rest } = p as Record<string, unknown>
  const out = scrub(rest) as Record<string, unknown>
  if (models && typeof models === "object" && !Array.isArray(models)) out.models = Object.fromEntries(Object.entries(models).map(([id, m]) => [id, scrub(m)]))
  else if (models !== undefined) out.models = models
  return out
}

/** OpenCode's config (GET/PATCH /config, /global/config): providers' options, MCP servers' headers, env and OAuth, any secret-named field. */
function scrubConfig(c: unknown): unknown {
  if (!c || typeof c !== "object" || Array.isArray(c)) return c
  const byId = (m: unknown, f: (x: unknown) => unknown) => (m && typeof m === "object" && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).map(([id, x]) => [id, f(x)])) : m)
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(c)) {
    if (isSecretName(k)) continue
    // Maps keyed by names the user chose (provider and MCP server ids) keep their keys; their values are scrubbed.
    out[k] = k === "provider" ? byId(x, scrubProvider) : k === "mcp" ? byId(x, scrub) : scrub(x)
  }
  return out
}

const REDACT: Record<string, (body: unknown) => unknown> = {
  // { providers: Provider[], default }: the model picker and boot read ids, names, models and costs.
  "config/providers": (b) => {
    const o = b as { providers?: unknown[] }
    return o && Array.isArray(o.providers) ? { ...o, providers: o.providers.map(scrubProvider) } : b
  },
  // { all: Provider[], default, connected }
  provider: (b) => {
    const o = b as { all?: unknown[] }
    return o && Array.isArray(o.all) ? { ...o, all: o.all.map(scrubProvider) } : b
  },
  config: scrubConfig,
  "global/config": scrubConfig,
  // Agents carry their model options.
  agent: (b) => (Array.isArray(b) ? b.map((a) => (a && typeof a === "object" ? { ...(a as object), options: scrub((a as { options?: unknown }).options ?? {}) } : a)) : b),
}

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
