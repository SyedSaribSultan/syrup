"use client"

import posthog from "posthog-js"
import { useEffect } from "react"

type AnalyticsUser = { id: string; admin: boolean; email: string | null; name: string | null }

/**
 * Ties the PostHog browser client to the signed-in user (stable account id, plus email and name for the person
 * profile) and applies the user's opt-out. Signing out (no user on a page after one was identified) resets PostHog
 * so the next person on this browser is a new anonymous visitor. Initialisation happens in
 * src/instrumentation-client.ts before React mounts.
 */
export function Analytics({ user }: { user: AnalyticsUser | null }) {
  const id = user?.id
  const admin = user?.admin
  const email = user?.email
  const name = user?.name
  useEffect(() => {
    if (!id) {
      try {
        // Signed out: forget the account, but keep personal-link (via:) visitors as they are.
        if (posthog.__loaded && posthog.get_property("$user_state") === "identified" && !posthog.get_distinct_id().startsWith("via:")) posthog.reset()
      } catch {}
      return
    }
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
          posthog.identify(id, { admin, ...(email ? { email } : {}), ...(name ? { name } : {}) })
        } catch {}
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, admin, email, name])
  return null
}
