"use client"

import { useSyncExternalStore } from "react"
import { THEME_KEY as KEY } from "./theme-script"

/**
 * Light / dark / follow the system. "system" sets data-mode="system" on <html> so the
 * prefers-color-scheme rules apply; the others set data-theme.
 * THEME_SCRIPT (theme-script.ts) applies a saved choice before first paint.
 */

export type Theme = "system" | "light" | "dark"

const subs = new Set<() => void>()
/** Counts theme switches, so an older switch never ends a newer one's transition-free frame. */
let switches = 0

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === "light" || t === "dark" ? t : "system"
  } catch {
    return "system"
  }
}

export function setTheme(t: Theme) {
  try {
    if (t === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {}
  const root = document.documentElement
  // One frame with transitions off (globals.css, "Theme switch"), so the whole app changes colour at once
  // instead of the elements with `transition` fading while the rest snap (docs/MOTION.md §4.8).
  // Two frames: the first rAF runs before the next style pass, so removing it there would suppress nothing.
  const switching = ++switches
  root.dataset.themeSwitching = ""
  // The Sarib tokens follow the OS only under data-mode="system"; a fixed choice is data-theme alone.
  if (t === "system") {
    delete root.dataset.theme
    root.dataset.mode = "system"
  } else {
    root.dataset.theme = t
    delete root.dataset.mode
  }
  for (const f of subs) f()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      // A newer switch (a quick second click) keeps it on for its own frame.
      if (switching === switches) delete root.dataset.themeSwitching
    }),
  )
}

function subscribe(f: () => void) {
  subs.add(f)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    setTheme(read())
  }
  window.addEventListener("storage", onStorage)
  return () => {
    subs.delete(f)
    window.removeEventListener("storage", onStorage)
  }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "system")
}

const DARK_QUERY = "(prefers-color-scheme: dark)"

function readScheme(): "light" | "dark" {
  const t = document.documentElement.dataset.theme
  if (t === "light" || t === "dark") return t
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light"
}

function subscribeScheme(f: () => void) {
  const mq = window.matchMedia(DARK_QUERY)
  mq.addEventListener("change", f)
  const off = subscribe(f)
  return () => {
    mq.removeEventListener("change", f)
    off()
  }
}

/** The scheme the page shows now: data-theme when set, else the system's. Re-renders when either changes (pictures are themed). */
export function useResolvedScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeScheme, readScheme, () => "light")
}
