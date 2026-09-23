"use client"

import posthog from "posthog-js"
import { useEffect } from "react"

/**
 * Ties the PostHog browser client to the signed-in user (an opaque id, never
 * the email) and applies the user's opt-out. Initialisation itself happens in
 * src/instrumentation-client.ts before React mounts.
 */
export function Analytics({ user }: { user: { id: string; admin: boolean } | null }) {
  useEffect(() => {
    if (!user) return
    let cancelled = false
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { analyticsOptOut?: boolean } | null) => {
        if (cancelled) return
        try {
          if (me?.analyticsOptOut) {
            posthog.opt_out_capturing()
            return
          }
          if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing()
          posthog.identify(user.id, { admin: user.admin })
        } catch {}
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [user])
  return null
}
