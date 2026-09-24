import NextAuth from "next-auth"
import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "./auth.config"

/**
 * Request guard, runs before every route.
 *
 * Local mode: the server only listens on 127.0.0.1, so the remaining threat is
 * DNS rebinding (a web page making your browser call "localhost" under another
 * Host). API requests must carry a loopback Host, and mutating requests a
 * loopback Origin.
 *
 * Cloud mode: everything except sign-in, legal pages, the auth endpoints, the
 * health check and the analytics proxy requires a session. /admin requires an
 * admin session.
 */

const MODE = process.env.SYRUP_MODE === "cloud" || process.env.SYRUP_MODE === "local" ? process.env.SYRUP_MODE : process.env.VERCEL ? "cloud" : "local"

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function hostnameOf(hostHeader: string | null): string {
  if (!hostHeader) return ""
  // Strip the port; IPv6 literals keep their brackets.
  const m = hostHeader.match(/^(\[[^\]]+\]|[^:]+)/)
  return (m?.[1] ?? "").toLowerCase()
}

function localGuard(req: NextRequest): NextResponse {
  if (!req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next()
  if (!LOOPBACK.has(hostnameOf(req.headers.get("host")))) {
    return NextResponse.json({ error: "syrup local mode only answers on localhost" }, { status: 403 })
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin")
    if (origin) {
      let ok = false
      try {
        ok = LOOPBACK.has(new URL(origin).hostname.toLowerCase()) || LOOPBACK.has(`[${new URL(origin).hostname.toLowerCase()}]`)
      } catch {}
      if (!ok) return NextResponse.json({ error: "cross-origin request refused" }, { status: 403 })
    }
    if (req.headers.get("sec-fetch-site") === "cross-site") {
      return NextResponse.json({ error: "cross-site request refused" }, { status: 403 })
    }
  }
  return NextResponse.next()
}

/** Local-engine features that have no cloud implementation yet (Phase 2/3). */
const LOCAL_ONLY_API = /^\/api\/(oc|memory|skills|usage|workspace|sarib)(\/|$)/
const LOCAL_ONLY_PAGE = /^\/(memory|skills|usage|s)(\/|$)/

const PUBLIC = [/^\/signin(\/|$)/, /^\/legal(\/|$)/, /^\/api\/auth(\/|$)/, /^\/api\/health$/, /^\/ingest(\/|$)/]

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
  if (MODE === "local") return localGuard(req)
  return cloudGuard(req, event)
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|txt|xml)$).*)"],
}
