"use client"

import { useSyncExternalStore } from "react"
import { THEME_KEY as KEY } from "./theme-script"

/**
 * Light / dark / follow the system. "system" leaves <html> alone so the
 * prefers-color-scheme rules in globals.css apply; the others set data-theme.
 * THEME_SCRIPT (theme-script.ts) applies a saved choice before first paint.
 */

export type Theme = "system" | "light" | "dark"

const subs = new Set<() => void>()

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
  if (t === "system") delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  for (const f of subs) f()
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
