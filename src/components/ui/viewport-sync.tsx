"use client"

import { useEffect } from "react"

/**
 * Keeps the app exactly as tall as the visible area on touch screens, so the
 * on-screen keyboard shrinks the layout instead of covering the composer.
 * Android does this by itself (interactive-widget=resizes-content); iOS
 * Safari doesn't yet, so --app-h follows visualViewport there. Skipped while
 * pinch-zoomed, where the visual viewport is a magnified window, not the
 * keyboard. See docs/RESPONSIVE.md §5.4.
 */
export function ViewportSync() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv || !window.matchMedia("(pointer: coarse)").matches) return
    const root = document.documentElement
    const sync = () => {
      if (Math.abs(vv.scale - 1) > 0.01) return
      root.style.setProperty("--app-h", `${Math.round(vv.height)}px`)
      // iOS pans the page to show the focused field; with the app sized to the visible area there is nothing to pan to.
      if (vv.offsetTop > 0) window.scrollTo(0, 0)
    }
    sync()
    vv.addEventListener("resize", sync)
    vv.addEventListener("scroll", sync)
    return () => {
      vv.removeEventListener("resize", sync)
      vv.removeEventListener("scroll", sync)
      root.style.removeProperty("--app-h")
    }
  }, [])
  return null
}
