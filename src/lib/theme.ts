"use client"

import { useSyncExternalStore } from "react"
import { THEME_KEY as KEY } from "./theme-script"

/**
 * Light or dark, set as data-theme on <html>. Every device starts in light, whatever the OS theme;
 * dark is a manual choice, remembered on this device. THEME_SCRIPT (theme-script.ts) applies a saved
 * dark choice before first paint.
 */

export type Theme = "light" | "dark"

const subs = new Set<() => void>()
/** Counts theme switches, so an older switch never ends a newer one's transition-free frame. */
let switches = 0

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === "dark" ? "dark" : "light"
  } catch {
    return "light"
  }
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t)
  } catch {}
  const root = document.documentElement
  // One frame with transitions off (globals.css, "Theme switch"), so the whole app changes colour at once
  // instead of the elements with `transition` fading while the rest snap (docs/MOTION.md §4.8).
  // Two frames: the first rAF runs before the next style pass, so removing it there would suppress nothing.
  const switching = ++switches
  root.dataset.themeSwitching = ""
  root.dataset.theme = t
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
  return useSyncExternalStore(subscribe, read, () => "light")
}

function readScheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light"
}

/** The scheme the page shows now (data-theme; light when unset). Re-renders when it changes (pictures are themed). */
export function useResolvedScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, readScheme, () => "light")
}
