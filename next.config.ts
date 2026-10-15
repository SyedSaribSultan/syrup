import type { NextConfig } from "next"

/**
 * Security headers for every response (audit 2026-10-15, H1).
 *
 * Enforced CSP: only what cannot break the app. No other site may frame syrup (clickjacking on key deletion, share
 * links, the egress editor); no <base> hijack; no plugins. X-Frame-Options repeats frame-ancestors for old browsers.
 * The app's own frames are a sandboxed srcdoc HTML preview and a blob: PDF viewer, neither of which frame-ancestors
 * or X-Frame-Options governs.
 *
 * Report-Only CSP: the full policy, watched in the browser console before it is enforced. Every origin the browser
 * talks to:
 * - 'self': pages, /_next assets (KaTeX fonts are bundled there), the API, and the PostHog reverse proxy (/ingest).
 * - https://*.vercel.run: each workspace's sandbox (OpenCode over fetch and SSE, src/lib/oc.ts; Sandbox#domain()).
 * - img https: the Google profile picture and images in rendered Markdown; data:/blob: for agent SVG and file previews.
 * - form-action accounts.google.com: "Continue with Google" posts a server action that redirects there.
 * Scripts keep 'unsafe-inline': Next's inline bootstrap and the theme script have no nonce (a nonce would make every
 * page dynamic, shares included). The srcdoc preview inherits this policy, which is why it is not enforced yet.
 */
const DEV = process.env.NODE_ENV !== "production"
const CSP_ENFORCED = ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'"].join("; ")
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' https://*.vercel.run${DEV ? " ws: http://127.0.0.1:* http://localhost:*" : ""}`,
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' blob: data:",
  "form-action 'self' https://accounts.google.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ")

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP_ENFORCED },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
]

const nextConfig: NextConfig = {
  // Native/ESM packages the server uses directly; keep them out of the bundler.
  serverExternalPackages: ["@opencode-ai/sdk", "@libsql/client", "cross-spawn", "@modelcontextprotocol/sdk", "@neondatabase/serverless", "ws", "posthog-node"],
  // Files read at runtime that the bundler cannot see: Postgres migrations and the legal texts.
  outputFileTracingIncludes: {
    "/**": ["./drizzle-pg/**/*", "./src/content/legal/*.md", "./.sidecar/*"],
  },
  // PostHog reverse proxy so analytics requests are first-party (see src/instrumentation-client.ts).
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: "https://eu-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/:path*", destination: "https://eu.i.posthog.com/:path*" },
    ]
  },
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Shared chats: public to anyone with the link, never indexed or archived, and never leaking the link through Referer.
      // Listed after the global entry so its Referrer-Policy wins (the last match of a key overrides).
      {
        source: "/c/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ]
  },
}

export default nextConfig
