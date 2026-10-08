"use client"

import { useCallback, useLayoutEffect, useState, type ReactNode } from "react"
import { restartEntrance, usePresence } from "@/lib/use-presence"

/**
 * Notice (docs/MOTION.md §4.6): one primitive for transient notes. M1: toasts, which fade and travel --motion-shift
 * from their side, fast (motion-notice). M2 adds status strips and banners (<Collapse> plus a fade).
 *
 * A notice stays mounted until its exit ends, so a new toast crossfades the old one instead of replacing it.
 * Keep them with useNotices() and render each with <Notice>.
 */
export function Notice({
  open,
  onExited,
  side = "up",
  place,
  className = "",
  children,
}: {
  open: boolean
  onExited(): void
  /** Where it comes from: "up" rises (above its anchor, or at the bottom of the screen), "down" drops (below its anchor). */
  side?: "up" | "down"
  /** Positions it before its first paint and returns the side it ended up on (a toast that flips above its anchor). */
  place?(el: HTMLDivElement): "up" | "down"
  className?: string
  children: ReactNode
}) {
  const p = usePresence<HTMLDivElement>(open, { onExited })
  const { mounted, ref } = p

  // Placed by measuring, which starts the entrance before the side is known: write the side and restart it (§4.5).
  useLayoutEffect(() => {
    const el = ref.current
    if (!mounted || !el || !place) return
    el.dataset.side = place(el)
    restartEntrance(el)
    // Once, when it appears: a toast stays where it was put.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted])

  if (!mounted) return null
  return (
    <div {...p.props} role="status" data-side={place ? undefined : side} className={`${className} motion-notice`}>
      {children}
    </div>
  )
}

/** A list of notices where only the newest is open: showing one closes the one before, which crossfades out. */
export function useNotices<T>() {
  const [items, setItems] = useState<(T & { id: number; open: boolean })[]>([])
  const show = useCallback((n: T) => {
    const id = nextNotice++
    setItems((list) => [...list.map((x) => (x.open ? { ...x, open: false } : x)), { ...n, id, open: true }])
  }, [])
  const hide = useCallback((id: number) => setItems((list) => list.map((x) => (x.id === id && x.open ? { ...x, open: false } : x))), [])
  const drop = useCallback((id: number) => setItems((list) => list.filter((x) => x.id !== id)), [])
  return { items, current: items.find((x) => x.open) ?? null, show, hide, drop }
}

let nextNotice = 1
