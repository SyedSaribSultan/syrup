export async function register() {
  // Only the Node.js server runtime can spawn processes and open SQLite.
  // Everything Node-specific lives in server/boot so the Edge compile of this file stays clean.
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { boot } = await import("./server/boot")
  await boot()
}

/**
 * Server errors Next.js captures (render, route handler, server action, proxy) go to PostHog error tracking
 * (src/server/analytics.ts reportServerError). Errors a route handler catches itself are reported by
 * internalError() in src/server/cloud/session.ts. Node runtime only; a no-op without a PostHog key.
 */
export async function onRequestError(err: unknown, request: { path: string; method: string }, context: { routePath: string; routeType: string }) {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return
  const { reportServerError } = await import("./server/analytics")
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined
  await reportServerError(err, { path: request.path.split("?")[0], method: request.method, routePath: context.routePath, routeType: context.routeType, digest })
}
