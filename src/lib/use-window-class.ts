"use client"

import { useSyncExternalStore } from "react"

/**
 * The window size class (docs/RESPONSIVE.md §3) and pointer type, for behaviour
 * that CSS can't express (open a sheet or a popover, autofocus or not). Layout
 * itself stays in CSS (medium: / expanded: / large: / pointer-coarse:), so the
 * server snapshot only has to be a sensible default: desktop with a mouse.
 */

export type WindowClass = "compact" | "medium" | "expanded" | "large"

const QUERIES = {
  medium: "(min-width: 37.5rem)",
  expanded: "(min-width: 52.5rem)",
  large: "(min-width: 75rem)",
  coarse: "(pointer: coarse)",
} as const

function mq(q: string): boolean {
  return window.matchMedia(q).matches
}

function subscribe(f: () => void) {
  const lists = Object.values(QUERIES).map((q) => window.matchMedia(q))
  for (const l of lists) l.addEventListener("change", f)
  return () => {
    for (const l of lists) l.removeEventListener("change", f)
  }
}

function readClass(): WindowClass {
  if (mq(QUERIES.large)) return "large"
  if (mq(QUERIES.expanded)) return "expanded"
  if (mq(QUERIES.medium)) return "medium"
  return "compact"
}

export function useWindowClass(): WindowClass {
  return useSyncExternalStore(subscribe, readClass, () => "large")
}

/** Phones and tablets: the sidebar is a drawer, menus open as bottom sheets, side panels go full-screen. */
export function useNarrow(): boolean {
  const c = useWindowClass()
  return c === "compact" || c === "medium"
}

/** A touch screen is the main pointer (no hover, fat fingers, on-screen keyboard). */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mq(QUERIES.coarse),
    () => false,
  )
}
