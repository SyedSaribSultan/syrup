import { PostHog } from "posthog-node"
import { env } from "./env"

/**
 * Server-side product analytics (docs/PLAN.md §6, layer B). Events only,
 * never content: no prompts, code, file names or keys go through here.
 * Callers pass the user id; opt-out is checked by the caller when it has the
 * user row, and enforced again here through a small cache.
 */

const g = globalThis as unknown as { __syrupPosthog?: PostHog | null; __syrupOptOut?: Map<string, boolean> }

function client(): PostHog | null {
  if (g.__syrupPosthog !== undefined) return g.__syrupPosthog
  if (!env.posthogKey) return (g.__syrupPosthog = null)
  // Serverless: send right away, nothing may be left in a buffer when the function ends.
  g.__syrupPosthog = new PostHog(env.posthogKey, { host: env.posthogHost, flushAt: 1, flushInterval: 0 })
  return g.__syrupPosthog
}

const optOut = (g.__syrupOptOut ??= new Map())

/** Remember a user's analytics choice for this process so hot paths need no DB read. */
export function setOptOut(userId: string, value: boolean) {
  optOut.set(userId, value)
}

export async function track(userId: string, event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const ph = client()
  if (!ph || optOut.get(userId)) return
  try {
    ph.capture({ distinctId: userId, event, properties: { ...properties, mode: env.mode } })
    await ph.flush()
  } catch {
    // Analytics never breaks a request.
  }
}

export async function identify(userId: string, properties: Record<string, unknown>): Promise<void> {
  const ph = client()
  if (!ph || optOut.get(userId)) return
  try {
    ph.identify({ distinctId: userId, properties })
    await ph.flush()
  } catch {}
}
