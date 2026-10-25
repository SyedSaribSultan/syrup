"use client"

import { useEffect } from "react"

/**
 * Label tips for icon-only controls: `data-s-tip="Label"` (sarib-design v2.2, components.js "label tips").
 * The same DOM as the library (one fixed `span.s-tooltip.s-tooltip--float[data-open]` in <body>, rails open to the
 * right), so the library's CSS draws it. components.js itself is not loaded: its document-level Esc, `cancel` and
 * ::backdrop handlers close any open <dialog>, and syrup's Dialog / Sheet own their <dialog>s (ui/dialog.tsx,
 * ui/sheet.tsx). Mounted once in the root layout; delegated listeners, so controls added later work too.
 * Fine pointers: hover (slow token first, instant while one is warm). Keyboard: focus-visible. Touch: none.
 */
export function Tips() {
  useEffect(() => {
    const doc = document
    let el: HTMLSpanElement | null = null
    let target: Element | null = null
    let timer = 0
    let warm = 0
    const token = (name: string) => getComputedStyle(doc.documentElement).getPropertyValue(name).trim()
    const px = (name: string) => parseFloat(token(name)) || 0
    const slow = () => {
      const v = token("--s-motion-duration-slow")
      return v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : 0
    }
    const float = () => {
      if (el && doc.contains(el)) return el
      el = doc.createElement("span")
      el.setAttribute("aria-hidden", "true")
      el.className = "s-tooltip s-tooltip--float"
      doc.body.append(el)
      return el
    }
    const place = (t: Element) => {
      const tip = float()
      const side = t.getAttribute("data-s-tip-side") || (t.closest(".s-sidebar--rail") ? "right" : "bottom")
      const r = t.getBoundingClientRect()
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      const gap = px("--s-spacing-3")
      let x = side === "right" ? r.right + gap : side === "left" ? r.left - gap - w : r.left + r.width / 2 - w / 2
      let y = side === "top" ? r.top - gap - h : side === "bottom" ? r.bottom + gap : r.top + r.height / 2 - h / 2
      if (side === "bottom" && y + h > innerHeight - gap) y = r.top - gap - h
      if (side === "top" && y < gap) y = r.bottom + gap
      x = Math.max(gap, Math.min(x, innerWidth - w - gap))
      y = Math.max(gap, Math.min(y, innerHeight - h - gap))
      tip.style.left = `${Math.round(x)}px`
      tip.style.top = `${Math.round(y)}px`
      tip.setAttribute("data-side", side)
    }
    const show = (t: Element, now = false) => {
      clearTimeout(timer)
      const go = () => {
        const tip = float()
        tip.textContent = t.getAttribute("data-s-tip")
        target = t
        place(t)
        tip.setAttribute("data-open", "")
      }
      if (now || Date.now() - warm < slow()) go()
      else timer = window.setTimeout(go, slow())
    }
    const hide = () => {
      clearTimeout(timer)
      if (!target) return
      target = null
      warm = Date.now()
      el?.removeAttribute("data-open")
    }
    const tipOf = (e: Event) => (e.target instanceof Element ? e.target.closest("[data-s-tip]") : null)

    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return
      const t = tipOf(e)
      if (t && t !== target && !t.matches(":disabled")) show(t)
      else if (!t) hide()
    }
    const out = (e: PointerEvent) => {
      const t = tipOf(e)
      if (t && !(e.relatedTarget instanceof Element && t.contains(e.relatedTarget))) hide()
    }
    const focusIn = (e: FocusEvent) => {
      const t = tipOf(e)
      if (t && t.matches(":focus-visible")) show(t, true)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && target) hide()
    }
    // A control that unmounts (a drawer closing, a route change) takes its tip with it.
    const gone = new MutationObserver(() => {
      if (target && !target.isConnected) hide()
    })
    gone.observe(doc.body, { subtree: true, childList: true })
    doc.addEventListener("pointerover", over)
    doc.addEventListener("pointerout", out)
    doc.addEventListener("focusin", focusIn)
    doc.addEventListener("focusout", hide)
    doc.addEventListener("pointerdown", hide, true)
    doc.addEventListener("scroll", hide, true)
    doc.addEventListener("keydown", esc, true)
    return () => {
      gone.disconnect()
      doc.removeEventListener("pointerover", over)
      doc.removeEventListener("pointerout", out)
      doc.removeEventListener("focusin", focusIn)
      doc.removeEventListener("focusout", hide)
      doc.removeEventListener("pointerdown", hide, true)
      doc.removeEventListener("scroll", hide, true)
      doc.removeEventListener("keydown", esc, true)
      clearTimeout(timer)
      el?.remove()
    }
  }, [])
  return null
}
