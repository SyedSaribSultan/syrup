import NextAuth from "next-auth"
import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "./auth.config"
import { localGuardDecision } from "./server/local-guard"

/**
 * Request guard, runs before every route.
 *
 * Local mode: the server only listens on 127.0.0.1, so the remaining threats are
 * DNS rebinding (a web page making your browser call "localhost" under another
 * Host) and pages on other loopback ports (an agent's dev server). Every request
 * must carry a loopback Host; API requests must also come from syrup's own
 * origin when the browser says where they come from (src/server/local-guard.ts).
 *
 * Cloud mode: everything except sign-in, legal pages, the auth endpoints, the
 * health check, the analytics proxy and shared chats (/c/…) requires a
 * session. /admin requires an admin session.
 */

const MODE = process.env.SYRUP_MODE === "cloud" || process.env.SYRUP_MODE === "local" ? process.env.SYRUP_MODE : process.env.VERCEL ? "cloud" : "local"

/** Local mode, every matched path: loopback Host; on /api also same-origin only (src/server/local-guard.ts). */
function localGuard(req: NextRequest): NextResponse | null {
  const d = localGuardDecision({
    method: req.method,
    pathname: req.nextUrl.pathname,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
  })
  return d.ok ? null : NextResponse.json({ error: d.error }, { status: d.status })
}

/** Local-only by design: the local engine proxy, local folder routes and local chat URLs. The cloud has its own equivalents. */
const LOCAL_ONLY_API = /^\/api\/(oc|workspace)(\/|$)/
const LOCAL_ONLY_PAGE = /^\/s(\/|$)/

/** Shared chats (/c/<id> and its /md, /json, /debug, /view, preview image) are readable without an account; ids are unguessable. */
const PUBLIC = [/^\/signin(\/|$)/, /^\/legal(\/|$)/, /^\/api\/auth(\/|$)/, /^\/api\/health$/, /^\/ingest(\/|$)/, /^\/c(\/|$)/]

const SHARE_PAGE = /^\/c\/([0-9A-Za-z]{22})(\.md|\.json)?$/

/** q-value of one media type in an Accept header (exact type only; 0 when absent). */
function acceptQ(accept: string, type: string): number {
  for (const part of accept.toLowerCase().split(",")) {
    const [t, ...params] = part.trim().split(";")
    if (t.trim() !== type) continue
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
    return q ? Number(q.slice(2)) || 0 : 1
  }
  return 0
}

/**
 * Machine-readable shares for tools: /c/<id>.md and /c/<id>.json, or /c/<id>
 * with Accept: text/markdown (preferred over HTML) or application/json, serve
 * the /md and /json variants. Browsers never ask for those, so they get the page.
 */
function shareVariant(req: NextRequest): NextResponse | null {
  const m = req.nextUrl.pathname.match(SHARE_PAGE)
  if (!m || (req.method !== "GET" && req.method !== "HEAD")) return null
  let fmt = m[2] === ".md" ? "md" : m[2] === ".json" ? "json" : null
  if (!fmt) {
    const accept = req.headers.get("accept") ?? ""
    const html = acceptQ(accept, "text/html")
    const md = acceptQ(accept, "text/markdown")
    const json = acceptQ(accept, "application/json")
    if (md > 0 && md >= html) fmt = "md"
    else if (json > 0 && json > html) fmt = "json"
  }
  if (!fmt) return null
  const url = req.nextUrl.clone()
  url.pathname = `/c/${m[1]}/${fmt}`
  const res = NextResponse.rewrite(url)
  res.headers.set("Vary", "Accept")
  return res
}

const { auth } = NextAuth(authConfig)

const cloudGuard = auth((req) => {
  const { pathname } = req.nextUrl
  if (PUBLIC.some((p) => p.test(pathname))) return NextResponse.next()
  if (LOCAL_ONLY_API.test(pathname)) return NextResponse.json({ error: "not available in the hosted version yet" }, { status: 501 })
  if (LOCAL_ONLY_PAGE.test(pathname)) return NextResponse.redirect(new URL("/", req.nextUrl.origin))
  const session = req.auth
  // Scripted access: a Bearer token is validated by the route itself (cloud/session.ts opsViewer).
  if (!session?.user && pathname.startsWith("/api/") && req.headers.get("authorization")?.startsWith("Bearer ")) return NextResponse.next()
  if (!session?.user) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "sign in required" }, { status: 401 })
    const url = new URL("/signin", req.nextUrl.origin)
    if (pathname !== "/") url.searchParams.set("next", pathname + req.nextUrl.search)
    return NextResponse.redirect(url)
  }
  if ((pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) && !session.user.admin) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "admin only" }, { status: 403 })
    return NextResponse.redirect(new URL("/", req.nextUrl.origin))
  }
  return NextResponse.next()
})

export default function proxy(req: NextRequest, event: Parameters<typeof cloudGuard>[1]) {
  // Local: the guard runs first, so a rebinding page can't reach a share's .md/.json rewrite either.
  if (MODE === "local") return localGuard(req) ?? shareVariant(req) ?? NextResponse.next()
  return shareVariant(req) ?? cloudGuard(req, event)
}

export const config = {
  // Everything except Next internals and static assets (the web manifest too: install prompts fetch it signed out).
  // Every /api path is matched on its own: an id ending in ".txt" or ".png" must not skip the guard.
  // One exception, /api/ingest/llm/<provider>/… (the cloud LLM relay): the guard would add a second function invocation and a 4 MB
  // body cap to every model call, and protects nothing there. That route is fail-closed by itself: it answers 404 in
  // local mode before reading anything, and in the cloud checks its ingest token first (src/app/api/ingest/llm/relay.ts).
  matcher: ["/api/((?!ingest/llm/[^/]+/).*)", "/((?!_next/static|_next/image|favicon\\.ico|api/ingest/llm/[^/]+/|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|txt|xml|webmanifest)$).*)"],
}
