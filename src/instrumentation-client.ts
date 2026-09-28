import posthog from "posthog-js"

/**
 * Browser analytics (docs/PLAN.md §6 layer B). Runs once before the app
 * becomes interactive. Events go through the /ingest reverse proxy so ad
 * blockers do not drop them. Replays mask every input and all text: no
 * prompt, code or key ever reaches a recording.
 */
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
// Shared chats (/c/…) load no analytics: their URL is the only key to a private chat, so it must not reach a third party.
const sharePage = typeof window !== "undefined" && /^\/c(\/|$)/.test(window.location.pathname)
if (key && typeof window !== "undefined" && !sharePage) {
  try {
    const dnt = navigator.doNotTrack === "1" || (window as unknown as { doNotTrack?: string }).doNotTrack === "1"
    posthog.init(key, {
      api_host: "/ingest",
      ui_host: "https://eu.posthog.com",
      defaults: "2026-05-30",
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      capture_pageleave: true,
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
