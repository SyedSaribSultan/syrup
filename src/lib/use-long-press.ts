"use client"

import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react"

/**
 * Long-press on touch screens opens the same actions a right-click does on
 * desktop. Android already fires contextmenu on a long press; iOS Safari
 * doesn't, so this times the press itself. Spread the handlers on the
 * element; the click that ends a long press is swallowed.
 */
export function useLongPress<T extends HTMLElement>(onLongPress: (x: number, y: number, target: T) => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    origin.current = null
  }

  return {
    onPointerDown(e: ReactPointerEvent<T>) {
      if (e.pointerType !== "touch") return
      fired.current = false
      origin.current = { x: e.clientX, y: e.clientY }
      const target = e.currentTarget
      const { clientX, clientY } = e
      timer.current = setTimeout(() => {
        fired.current = true
        timer.current = null
        onLongPress(clientX, clientY, target)
      }, ms)
    },
    onPointerMove(e: ReactPointerEvent<T>) {
      const o = origin.current
      // A scroll or swipe is not a press.
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture(e: ReactMouseEvent<T>) {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    // Android fires its own long-press contextmenu. Whichever comes first wins, so the menu opens once:
    // if it beats the timer, the element's onContextMenu handles it; if the timer won, swallow it.
    onContextMenuCapture(e: ReactMouseEvent<T>) {
      if (timer.current) cancel()
      else if (fired.current) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }
}
