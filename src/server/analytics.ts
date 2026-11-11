import { PostHog } from "posthog-node"
import { env } from "./env"

/**
 * Server-side product analytics (docs/PLAN.md §6, layer B). Events only,
 * never content: no prompts, code, file names or keys go through here.
 * Callers pass the user id; opt-out is enforced here for every capture and
 * identify, through a cache that expires (isOptedOut).
 */

const g = globalThis as unknown as { __syrupPosthog?: PostHog | null; __syrupOptOut?: Map<string, { out: boolean; at: number }> }

function client(): PostHog | null {
  if (g.__syrupPosthog !== undefined) return g.__syrupPosthog
  if (!env.posthogKey) return (g.__syrupPosthog = null)
  // Serverless: send right away, nothing may be left in a buffer when the function ends.
  g.__syrupPosthog = new PostHog(env.posthogKey, { host: env.posthogHost, flushAt: 1, flushInterval: 0 })
  return g.__syrupPosthog
}

/**
 * The user's analytics choice, cached per process for a minute. The row (users.analytics_opt_out) is the one owner:
 * an opt-out made on another instance reaches this one within OPT_OUT_TTL_MS, and every capture and identify goes
 * through isOptedOut().
 */
const OPT_OUT_TTL_MS = 60_000
const optOut = (g.__syrupOptOut ??= new Map())

/** Remember a user's analytics choice (just read or just changed) so hot paths need no DB read. */
export function setOptOut(userId: string, value: boolean) {
  optOut.set(userId, { out: value, at: Date.now() })
}

/**
 * Whether this user opted out of analytics. The cache answers while fresh; otherwise (a fresh serverless instance, or
 * an answer over a minute old) the cloud reads the user row, so an opted-out user is never tracked just because this
 * process saw an older choice. A failed read counts as opted out.
 */
async function isOptedOut(userId: string): Promise<boolean> {
  const known = optOut.get(userId)
  if (known && Date.now() - known.at < OPT_OUT_TTL_MS) return known.out
  if (!env.isCloud) return false
  try {
    const { eq } = await import("drizzle-orm")
    const { pg, pgReady, pgSchema } = await import("./db/pg")
    await pgReady()
    const [row] = await pg().select({ out: pgSchema.users.analyticsOptOut }).from(pgSchema.users).where(eq(pgSchema.users.id, userId))
    const out = row ? row.out : true
    setOptOut(userId, out)
    return out
  } catch {
    return true
  }
}

export async function track(userId: string, event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const ph = client()
  if (!ph || (await isOptedOut(userId))) return
  try {
    ph.capture({ distinctId: userId, event, properties: { ...properties, site: "syrup", mode: env.mode } })
    await ph.flush()
  } catch {
    // Analytics never breaks a request.
  }
}

export async function identify(userId: string, properties: Record<string, unknown>): Promise<void> {
  const ph = client()
  if (!ph || (await isOptedOut(userId))) return
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
