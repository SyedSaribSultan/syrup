"use client"

import { modelLabel } from "@/lib/model-label"
import { describeDrops, type Attempt } from "@/lib/router-status"
import { useLiveAttempts } from "@/lib/use-live-attempts"

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

/** The waiting line's text (src/lib/router-status.ts describeDrops, unit-tested there). */
export function describe(attempts: Attempt[]): string | null {
  return describeDrops(attempts, modelLabel)
}
