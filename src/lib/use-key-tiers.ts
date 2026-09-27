"use client"

import { useEffect, useSyncExternalStore } from "react"

export type KeyTier = "free" | "paid"
/** Tier of each provider's active stored key. Providers without a stored key (built-in, env-only) are absent. */
export type KeyTiers = ReadonlyMap<string, KeyTier>

type ProvidersResponse = { providers: { id: string; keys: { tier: KeyTier; active: boolean }[] }[] }

// One shared copy for every picker on the page; GET /api/providers answers the same shape locally and in the cloud.
let tiers: KeyTiers | null = null
let inflight: Promise<void> | null = null
let lastFetch = 0
const listeners = new Set<() => void>()

function refresh(): Promise<void> {
  inflight ??= (async () => {
    try {
      const r = await fetch("/api/providers", { cache: "no-store" })
      if (!r.ok) return
      const body = (await r.json()) as ProvidersResponse
      const next = new Map<string, KeyTier>()
      for (const p of body.providers) {
        const k = p.keys.find((x) => x.active)
        if (k) next.set(p.id, k.tier)
      }
      tiers = next
      lastFetch = Date.now()
      for (const l of listeners) l()
    } catch {
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Key tiers per provider, null until the first load. Refetches on mount (while `active`) once the copy is older than `maxAgeMs`. */
export function useKeyTiers(active = true, maxAgeMs = 15_000): KeyTiers | null {
  const value = useSyncExternalStore(subscribe, () => tiers, () => null)
  useEffect(() => {
    if (active && Date.now() - lastFetch > maxAgeMs) void refresh()
  }, [active, maxAgeMs])
  return value
}
