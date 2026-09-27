"use client"

import { useSyncExternalStore } from "react"

/** Starred and recently used models for the picker, kept per browser. Keys are "providerID/modelID". */

const FAV_KEY = "syrup.modelFavorites"
const REC_KEY = "syrup.modelRecents"
export const MAX_FAVORITES = 6
const MAX_RECENTS = 8

type Prefs = { favorites: string[]; recents: string[] }

const EMPTY: Prefs = { favorites: [], recents: [] }
// Parsed prefs plus the raw strings they came from, so a change made by another tab is picked up on the next read.
let cache: { fav: string | null; rec: string | null; prefs: Prefs } | null = null
const listeners = new Set<() => void>()

export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

function raw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function parse(s: string | null): string[] {
  try {
    const v: unknown = JSON.parse(s ?? "[]")
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

function snapshot(): Prefs {
  const fav = raw(FAV_KEY)
  const rec = raw(REC_KEY)
  if (!cache || cache.fav !== fav || cache.rec !== rec) cache = { fav, rec, prefs: { favorites: parse(fav), recents: parse(rec) } }
  return cache.prefs
}

/** Saves one list only, so a write never replaces the other list with an older copy. */
function write(key: typeof FAV_KEY | typeof REC_KEY, list: string[]) {
  const prev = snapshot()
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {}
  // Re-reading the raw values keeps the change in memory for this tab even when storage is blocked.
  cache = { fav: raw(FAV_KEY), rec: raw(REC_KEY), prefs: key === FAV_KEY ? { ...prev, favorites: list } : { ...prev, recents: list } }
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === FAV_KEY || e.key === REC_KEY) l()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(l)
    window.removeEventListener("storage", onStorage)
  }
}

export function useModelPrefs(): Prefs {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}

/**
 * Stars or unstars a model. Returns false when the favorites list is already full.
 * With `exists`, stars on models that are no longer available give up their slot first:
 * the picker can't show them, so they could never be unstarred.
 */
export function toggleFavorite(key: string, exists?: (key: string) => boolean): boolean {
  const { favorites } = snapshot()
  if (favorites.includes(key)) {
    write(FAV_KEY, favorites.filter((k) => k !== key))
    return true
  }
  const kept = favorites.length >= MAX_FAVORITES && exists ? favorites.filter(exists) : favorites
  if (kept.length >= MAX_FAVORITES) return false
  write(FAV_KEY, [...kept, key])
  return true
}

export function recordRecent(key: string) {
  const { recents } = snapshot()
  if (recents[0] === key) return
  write(REC_KEY, [key, ...recents.filter((k) => k !== key)].slice(0, MAX_RECENTS))
}
