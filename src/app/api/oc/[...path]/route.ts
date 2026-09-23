import { engine, engineAuthHeader } from "@/server/engine/opencode"
import { ensureSarib } from "@/server/sarib"

/**
 * Transparent proxy to the embedded OpenCode server. The browser uses the
 * typed OpenCode SDK pointed at /api/oc, so the whole engine API (sessions,
 * SSE events, permissions, files, PTY) is available without re-wrapping it.
 * Auth and multi-user policy will hook in here later.
 */

export const dynamic = "force-dynamic"

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"])

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  const { url: base } = await engine()
  const incoming = new URL(req.url)
  const target = new URL(`${base}/${path.join("/")}`)
  target.search = incoming.search

  // Give workspaces with .sarib files the sarib tools. Before a prompt it is
  // awaited (bounded) so the turn already sees them; otherwise it runs in the background.
  const dir = incoming.searchParams.get("directory")
  if (dir) {
    const ready = ensureSarib(dir)
    if (req.method === "POST" && /^session\/[^/]+\/(prompt_async|message)$/.test(path.join("/"))) {
      await Promise.race([ready, new Promise((r) => setTimeout(r, 5_000))])
    }
  }

  const headers = new Headers()
  req.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "authorization") headers.set(k, v)
  })
  // The engine is password-protected; only this proxy knows the password.
  headers.set("authorization", engineAuthHeader())

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
  const out = new Headers(upstream.headers)
  out.delete("content-encoding")
  out.delete("content-length")
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
