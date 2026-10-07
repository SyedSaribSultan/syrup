"use client"

import { modelLabel } from "@/lib/model-label"
import type { Attempt } from "@/lib/router-status"
import { useLiveAttempts } from "@/lib/use-live-attempts"

/** Why a model was dropped, in a few plain words. */
const WHY: Record<string, string> = {
  overloaded: "is overloaded",
  timeout: "didn't answer in time",
  rpm: "hit its rate limit",
  rpd: "used up its daily quota",
  tpm: "can't take a request this size",
  auth: "rejected the key",
  bad_request: "rejected the request",
  context: "can't fit this conversation",
  network: "couldn't be reached",
  empty: "answered with nothing",
  error: "failed",
}

/**
 * While the first token is still to come: what the router tried and gave up
 * on, so a long wait is explained rather than silent. Nothing is shown until
 * a model has actually been dropped; a chat that answers normally never sees
 * this line. `since`: when the wait began (the user message's time), so
 * attempts from earlier turns stay out of it.
 */
export function RouterProgress({ sessionID, since, active }: { sessionID: string; since: number; active: boolean }) {
  const attempts = useLiveAttempts(sessionID, active)
  const line = describe(attempts.filter((a) => a.ts >= since - 2_000))
  if (!line) return null
  return (
    <div className="mt-1 text-[12px] leading-snug text-muted" role="status">
      {line}
    </div>
  )
}

export function describe(attempts: Attempt[]): string | null {
  // "hedged" means a second model raced the first and lost; nothing went wrong.
  const failed = attempts.filter((a) => a.status !== "ok" && a.reason !== "hedged")
  if (failed.length === 0) return null
  const last = failed[failed.length - 1]
  const why = WHY[last.reason ?? ""] ?? "failed"
  const name = modelLabel(last.modelId)
  if (failed.length === 1) return `${name} ${why}. Trying another model…`
  return `${name} ${why}, ${failed.length - 1} other${failed.length === 2 ? "" : "s"} before it. Trying another model…`
}
