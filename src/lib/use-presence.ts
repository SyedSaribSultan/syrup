"use client"

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

/**
 * usePresence(open): keeps a closing thing mounted until its exit ends (docs/MOTION.md §4.1).
 *
 * - `mounted` says whether to render it; spread `props` onto the element that animates. Its `data-state` is
 *   "open" | "closed", and the CSS (a motion-* utility in globals.css) animates between the two.
 * - Open is the element's normal look, so nothing is hidden before JS runs (the HTML export has none). The entrance
 *   starts from `@starting-style`, the first frame the element is rendered.
 * - Closing keeps it mounted with data-state="closed" plus `inert` (and the utilities add pointer-events: none), so a tap
 *   during the fade can't fire a menu item again: useDismiss has already let go of it (src/lib/use-dismiss.ts).
 * - It unmounts on `transitionend` of the element itself (not a bubbling child's hover fade) for the property that ends
 *   last, read from the element's computed transition when the exit starts, and only for a transition that started after
 *   the exit did. Closing during the entrance cancels the entrance (a `transitioncancel`), and a property the close
 *   doesn't change (a popover's travel) finishes its entrance: neither is the exit. A timeout is required, not just a
 *   fallback: a 0 ms transition fires no events, and it also ends an exit whose transition was cancelled.
 * - `skipExit()` closes without the exit (the hand-off rule, §4.3): call it before the close. Overlays with
 *   `handoff: true` also skip their exit when another overlay opens while they are still leaving.
 */

export type PresenceState = "open" | "closed"

export type Presence<T extends HTMLElement> = {
  /** Render the element while this is true. */
  mounted: boolean
  /** Mounted and playing its exit. */
  closing: boolean
  /** The element, once rendered (for a caller that positions it). */
  ref: RefObject<T | null>
  /** Spread onto the element that animates. */
  props: { ref: RefObject<T | null>; "data-state": PresenceState; inert: boolean | undefined }
  /** Close without the exit animation. Call it before the close (in the same event), or while closing to end it now. */
  skipExit(): void
}

type Options = {
  /** Runs once the element has gone (after its exit, or at once when the exit was skipped). */
  onExited?(): void
  /** An overlay (menu, sheet, dialog, viewer): when another overlay opens while this one is leaving, this one goes at once. */
  handoff?: boolean
}

/** What the timeout adds to the longest transition before it unmounts anyway. transitionend normally comes first. */
const SLACK_MS = 50

// ---------------------------------------------------------------- hand-offs between overlays (MOTION.md §4.3)

/** Overlays playing their exit: each entry ends that exit now. */
const leaving = new Set<() => void>()
/** An overlay opened in the current task (the commit that is running), so one starting to leave in it goes at once. */
let openingNow = false

function overlayOpened() {
  for (const end of [...leaving]) end()
  openingNow = true
  queueMicrotask(() => {
    openingNow = false
  })
}

// ---------------------------------------------------------------- where focus goes back to (MOTION.md §4.2, §4.3)

/** Each overlay's opener: what had focus when it opened. Keyed by the overlay's element, so a removed one is forgotten. */
const openers = new WeakMap<Element, Element>()

/** Notes what had focus as `overlay` opened, unless focus has already moved into it (an autofocused field). */
export function noteOpener(overlay: Element, before: Element | null) {
  if (before && before !== document.body && !overlay.contains(before)) openers.set(overlay, before)
}

/**
 * Where focus goes back to when an overlay closes: `before`, what had it when the overlay opened. When that was an item
 * of a menu that has gone since (the menu handed off to this overlay, §4.3: chat ⋯ → Delete chat), it is that menu's
 * opener instead, and so on. A removed element keeps its own subtree, so the menu around the item is still found.
 */
export function focusReturn(before: Element | null): HTMLElement | null {
  let el = before
  for (let hops = 0; el && !el.isConnected && hops < 8; hops++) {
    let host: Element | null = el
    while (host && !openers.has(host)) host = host.parentElement
    el = host ? (openers.get(host) ?? null) : null
  }
  return el instanceof HTMLElement && el.isConnected ? el : null
}

// ---------------------------------------------------------------- the hook

export function usePresence<T extends HTMLElement = HTMLElement>(open: boolean, { onExited, handoff = false }: Options = {}): Presence<T> {
  const [s, setS] = useState({ open, mounted: open, skip: false })
  let cur = s
  if (open !== s.open) {
    // Adjusting state to a prop change during render (react.dev, "Storing information from previous renders").
    cur = { open, mounted: open || (s.mounted && !s.skip), skip: false }
    setS(cur)
  }
  const closing = cur.mounted && !cur.open
  const ref = useRef<T | null>(null)

  const skipExit = useCallback(() => setS((x) => (x.open ? { ...x, skip: true } : x.mounted ? { ...x, mounted: false } : x)), [])

  // The exit: wait for the element's last transition to end, or the timeout.
  useLayoutEffect(() => {
    if (!closing) return
    const el = ref.current
    const exit = el ? exitTiming(el) : { ms: 0, props: new Set<string>() }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      setS((x) => (x.open ? x : { ...x, mounted: false }))
    }
    // Only the element's own transitions (a child's hover fade bubbles up), not its ::backdrop's.
    const own = (e: TransitionEvent) => e.target === el && !e.pseudoElement
    // The exit's transitions: those that start from here on. Events are dispatched a frame after the style change, so
    // these listeners are in place before any of them. The entrance's own `transitioncancel` (a close during the entrance)
    // comes before the exit's `transitionrun`, and the entrance's leftover `transitionend`s have no run here, so neither
    // ends the exit early. A genuinely cancelled exit is left to the timeout.
    const started = new Set<string>()
    const onRun = (e: TransitionEvent) => {
      if (own(e)) started.add(e.propertyName)
    }
    const onEnd = (e: TransitionEvent) => {
      if (own(e) && started.has(e.propertyName) && (exit.props.has(e.propertyName) || exit.props.has("all"))) finish()
    }
    el?.addEventListener("transitionrun", onRun)
    el?.addEventListener("transitionend", onEnd)
    const timer = window.setTimeout(finish, exit.ms + SLACK_MS)
    return () => {
      done = true
      window.clearTimeout(timer)
      el?.removeEventListener("transitionrun", onRun)
      el?.removeEventListener("transitionend", onEnd)
    }
  }, [closing])

  // Hand-offs: an overlay opening ends the exits of overlays still leaving; one starting to leave as another opens skips it.
  useLayoutEffect(() => {
    if (!handoff || !open) return
    overlayOpened()
    // What had focus as it opened (its trigger), for a dialog this overlay hands off to (focusReturn).
    if (ref.current) noteOpener(ref.current, document.activeElement)
  }, [handoff, open])
  useLayoutEffect(() => {
    if (!handoff || !closing) return
    if (openingNow) {
      // Synchronously, before paint: the leaving overlay must not show a single closing frame over the one opening.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      skipExit()
      return
    }
    leaving.add(skipExit)
    return () => {
      leaving.delete(skipExit)
    }
  }, [handoff, closing, skipExit])

  // onExited, once per exit.
  const exited = useRef(onExited)
  useEffect(() => {
    exited.current = onExited
  })
  const wasMounted = useRef(cur.mounted)
  useEffect(() => {
    if (wasMounted.current && !cur.mounted) exited.current?.()
    wasMounted.current = cur.mounted
  }, [cur.mounted])

  return {
    mounted: cur.mounted,
    closing,
    ref,
    props: { ref, "data-state": cur.open ? "open" : "closed", inert: closing || undefined },
    skipExit,
  }
}

/**
 * When the exit ends: the longest duration + delay among the element's transitions (now that data-state="closed"
 * applies), and the properties that end then. A 0 ms exit (or no transition) ends at once, through the timeout.
 */
function exitTiming(el: HTMLElement): { ms: number; props: Set<string> } {
  const cs = getComputedStyle(el)
  const names = cs.transitionProperty.split(",").map((p) => p.trim())
  const durations = cs.transitionDuration.split(",").map(seconds)
  const delays = cs.transitionDelay.split(",").map(seconds)
  let ms = 0
  const props = new Set<string>()
  names.forEach((name, i) => {
    // Lists shorter than transition-property repeat (CSS Transitions §2).
    const end = Math.max(0, (durations[i % durations.length] ?? 0) + (delays[i % delays.length] ?? 0))
    if (end > ms) {
      ms = end
      props.clear()
    }
    if (end === ms && end > 0) props.add(name)
  })
  return { ms, props }
}

function seconds(v: string): number {
  const t = v.trim()
  const n = parseFloat(t)
  if (Number.isNaN(n)) return 0
  return t.endsWith("ms") ? n : n * 1000
}

/**
 * Restarts an element's `@starting-style` entrance. For an element whose travel side is only known after measuring it
 * (PointerMenu, a toast that flips above its anchor, a Popover with side="auto"; MOTION.md §4.5): measuring forces its
 * first style, so the entrance has already started without the side. Re-inserting the node in place drops that style,
 * and the next frame starts the entrance again with the side written. Call it in the same layout effect, before paint.
 */
export function restartEntrance(el: HTMLElement) {
  el.parentNode?.insertBefore(el, el.nextSibling)
}

// ---------------------------------------------------------------- the overlay around a menu

/** The overlay a menu sits in (Popover, Sheet), so a menu item can close it without the exit (MOTION.md §4.3). */
export const OverlayContext = createContext<{ skipExit(): void } | null>(null)

/** The enclosing overlay, if any. A menu item that opens another overlay or navigates calls `skipExit()` before closing it. */
export function useOverlay() {
  return useContext(OverlayContext)
}
