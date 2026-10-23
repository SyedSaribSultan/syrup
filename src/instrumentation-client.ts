import posthog from "posthog-js"

/**
 * Browser analytics (docs/PLAN.md §6 layer B). Runs once before the app becomes interactive. Config follows the
 * shared syedsarib.com tracking spec (one EU PostHog project for every site, events through the managed proxy
 * https://e.syedsarib.com so ad blockers do not drop them), plus syrup's stricter privacy: replays mask every input
 * and all text, autocapture never reads DOM text, DNT and the Settings opt-out are honoured. No prompt, code or key
 * ever reaches PostHog.
 */
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
// Shared chats (/c/…) load no analytics: their URL is the only key to a private chat, so it must not reach a third party.
const sharePage = typeof window !== "undefined" && /^\/c(\/|$)/.test(window.location.pathname)
if (key && typeof window !== "undefined" && !sharePage) {
  try {
    const dnt = navigator.doNotTrack === "1" || (window as unknown as { doNotTrack?: string }).doNotTrack === "1"
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://e.syedsarib.com",
      ui_host: "https://eu.posthog.com",
      defaults: "2026-08-30",
      person_profiles: "always",
      cross_subdomain_cookie: true,
      enable_heatmaps: true,
      capture_performance: { web_vitals: true },
      respect_dnt: true,
      opt_out_capturing_by_default: dnt,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
      },
      // Never read text out of the DOM for autocaptured elements.
      autocapture: { element_allowlist: ["button", "a"], css_selector_allowlist: ["[data-ph]"] },
      mask_all_text: true,
      mask_all_element_attributes: true,
      loaded(ph) {
        ph.register({ site: "syrup" })
        // Personal links: ?via=<name> names this visitor (unless signed in), then leaves the URL clean.
        try {
          const u = new URL(location.href)
          const via = (u.searchParams.get("via") || "").trim().toLowerCase().slice(0, 60)
          if (via) {
            if (ph.get_property("$user_state") !== "identified") ph.identify("via:" + via, { name: via, via })
            else ph.setPersonProperties({ via })
            ph.capture("via_link_opened", { via })
            u.searchParams.delete("via")
            history.replaceState(history.state, "", u.pathname + (u.search || "") + u.hash)
          }
        } catch {}
      },
    })
  } catch {
    // Analytics never breaks the app.
  }
}

export function onRouterTransitionStart(url: string) {
  try {
    if (posthog.__loaded && !/^\/c(\/|$)/.test(new URL(url, window.location.origin).pathname)) posthog.capture("$pageview_start", { url })
  } catch {}
}
