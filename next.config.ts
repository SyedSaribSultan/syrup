import type { NextConfig } from "next"

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
  // Shared chats: public to anyone with the link, never indexed or archived, and never leaking the link through Referer.
  async headers() {
    return [
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
