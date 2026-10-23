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

/**
 * Whether this user opted out of analytics. The cache answers when it can; on a miss (a fresh serverless
 * instance) the cloud reads the user row once, so an opted-out user is never tracked just because their
 * settings weren't loaded in this process yet. A failed read counts as opted out.
 */
async function isOptedOut(userId: string): Promise<boolean> {
  const known = optOut.get(userId)
  if (known !== undefined) return known
  if (!env.isCloud) return false
  try {
    const { eq } = await import("drizzle-orm")
    const { pg, pgReady, pgSchema } = await import("./db/pg")
    await pgReady()
    const [row] = await pg().select({ out: pgSchema.users.analyticsOptOut }).from(pgSchema.users).where(eq(pgSchema.users.id, userId))
    const out = row ? row.out : true
    optOut.set(userId, out)
    return out
  } catch {
    return true
  }
}

export async function track(userId: string, event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const ph = client()
  if (!ph || (await isOptedOut(userId))) return
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

/**
 * Server error tracking (audit 2026-10-15 M2) through PostHog's error tracking, no other vendor. Not tied to a person:
 * the distinct id is "server", and the message and stack go through the secret redaction the logs use. Does nothing
 * without a PostHog key; never throws.
 */
export async function reportServerError(err: unknown, properties: Record<string, unknown> = {}): Promise<void> {
  const ph = client()
  if (!ph) return
  try {
    const { redactText } = await import("@/lib/redact")
    const clean = (s: string | undefined) => (s ? redactText(s).text : s)
    const e = err instanceof Error ? err : new Error(String(err))
    const safe = new Error(clean(e.message))
    safe.name = e.name
    safe.stack = clean(e.stack)
    await ph.captureExceptionImmediate(safe, "server", { ...properties, mode: env.mode, $process_person_profile: false })
  } catch {
    // Error reporting never breaks a request.
  }
}
