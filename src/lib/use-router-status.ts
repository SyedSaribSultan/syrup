"use client"

import { useEffect, useSyncExternalStore } from "react"
import type { RouterStatus } from "./router-status"

// One shared poller for every component that shows router state.
let cache: RouterStatus | null = null
let inflight: Promise<void> | null = null
let lastFetch = 0
const listeners = new Set<() => void>()

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

async function refresh(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await fetch("/api/router/status", { cache: "no-store" })
      if (!r.ok) return
      cache = (await r.json()) as RouterStatus
      lastFetch = Date.now()
      for (const l of listeners) l()
    } catch {
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Router health, cooldowns and alias picks. Always returns the latest shared snapshot;
 * polls every `intervalMs` while `active`, and on tab focus.
 */
export function useRouterStatus(active = true, intervalMs = 15_000): RouterStatus | null {
  const status = useSyncExternalStore(subscribe, () => cache, () => null)
  useEffect(() => {
    if (!active) return
    if (Date.now() - lastFetch > 3_000) void refresh()
    const t = setInterval(() => void refresh(), intervalMs)
    const onFocus = () => document.visibilityState === "visible" && void refresh()
    document.addEventListener("visibilitychange", onFocus)
    return () => {
      clearInterval(t)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, [active, intervalMs])
  return status
}

/** Force a refresh, e.g. right after a message finishes. */
export function refreshRouterStatus(): void {
  void refresh()
}
