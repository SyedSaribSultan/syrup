import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Native/ESM packages the server uses directly; keep them out of the bundler.
  serverExternalPackages: ["@opencode-ai/sdk", "@libsql/client", "cross-spawn", "@modelcontextprotocol/sdk", "@neondatabase/serverless", "ws", "posthog-node"],
  // Files read at runtime that the bundler cannot see: Postgres migrations and the legal texts.
  outputFileTracingIncludes: {
    "/**": ["./drizzle-pg/**/*", "./src/content/legal/*.md"],
  },
  // PostHog reverse proxy so analytics requests are first-party (see src/instrumentation-client.ts).
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: "https://eu-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/:path*", destination: "https://eu.i.posthog.com/:path*" },
    ]
  },
  skipTrailingSlashRedirect: true,
}

export default nextConfig
