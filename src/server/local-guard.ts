/**
 * Local origin guard (RENDERING §3.G). Pure: no Node or Next imports, so src/proxy.ts and the tests load it as is.
 *
 * Local syrup listens on 127.0.0.1 only. What is left is other pages in the same browser: a DNS-rebinding page
 * (a foreign Host) and any page on another loopback port (an agent's Vite app on :5173, the preview listener).
 * - Every path the proxy matcher covers, pages included: the Host must be loopback.
 * - /api/* also: Sec-Fetch-Site, when sent, must be same-origin or none; Origin, when sent, must be exactly
 *   http://<Host> ("null" and other ports refused). Clients that send neither (curl, scripts, server code) pass.
 */

export type GuardInput = { method: string; pathname: string; host: string | null; origin: string | null; secFetchSite: string | null }
export type GuardDecision = { ok: true } | { ok: false; status: 403; error: string }

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/** The Host header's name without the port; IPv6 literals keep their brackets. "" when unparseable. */
function hostnameOf(host: string): string {
  const m = host.trim().toLowerCase().match(/^(\[[0-9a-f:.]+\]|[^:[\]]+)(:\d{1,5})?$/)
  return m?.[1] ?? ""
}

const refuse = (error: string): GuardDecision => ({ ok: false, status: 403, error })

export function localGuardDecision(r: GuardInput): GuardDecision {
  const host = (r.host ?? "").trim().toLowerCase()
  if (!host || !LOOPBACK.has(hostnameOf(host))) return refuse("syrup local mode only answers on localhost")
  if (!/^\/api(\/|$)/.test(r.pathname)) return { ok: true }
  const site = r.secFetchSite?.trim().toLowerCase()
  if (site && site !== "same-origin" && site !== "none") return refuse("cross-site request refused")
  if (r.origin !== null && r.origin.trim().toLowerCase() !== `http://${host}`) return refuse("cross-origin request refused")
  return { ok: true }
}

/** Request headers never passed to the engine: hop-by-hop ones, the client's own authorization, and what identifies the page. */
const DROP_REQUEST = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "authorization", "origin", "referer", "cookie"])

/** The browser's request headers as the engine should see them, with the engine's own password. */
export function proxyRequestHeaders(incoming: Headers, engineAuth: string): Headers {
  const out = new Headers()
  incoming.forEach((v, k) => {
    if (!DROP_REQUEST.has(k.toLowerCase())) out.set(k, v)
  })
  // The engine is password-protected; only the proxy knows the password.
  out.set("authorization", engineAuth)
  return out
}

/** The engine's response headers as the browser should see them: no stale encoding or length (the body is re-streamed), no CORS grants. */
export function proxyResponseHeaders(upstream: Headers): Headers {
  const out = new Headers()
  upstream.forEach((v, k) => {
    const key = k.toLowerCase()
    if (key === "content-encoding" || key === "content-length" || key.startsWith("access-control-")) return
    out.append(k, v)
  })
  return out
}
