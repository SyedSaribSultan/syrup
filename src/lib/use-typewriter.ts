"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Typewriter reveal for streamed text (same loop as syedsarib.com's chat): text
 * lands in chunks and is revealed on animation frames at a steady pace, so short
 * and long answers read at one deliberate rhythm. Text that was already complete
 * when it mounted (history) shows at once; reduced-motion users get it instantly.
 */

const CHARS_PER_SECOND = 70
// Long agent answers must not trail the stream by more than about this many seconds.
const MAX_LAG_SECONDS = 1.5
// A reply that finished this recently arrived in front of the user.
const FRESH_MS = 5_000

/** `live`: still streaming. `endedAt`: when the text finished; a reply that finished moments ago still types out (fast models often deliver it in one piece). */
export function useTypewriter(text: string, live: boolean, endedAt?: number): string {
  // Decided once per mount, so history and chat switches show text at once.
  const [animate] = useState(() => {
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false
    return live || (endedAt !== undefined && Date.now() - endedAt < FRESH_MS)
  })
  const [shown, setShown] = useState(() => (animate ? 0 : text.length))
  const target = useRef(text.length)

  useEffect(() => {
    target.current = text.length
  }, [text])

  useEffect(() => {
    if (!animate) return
    let raf = 0
    let last = performance.now()
    let budget = 0
    let cur = 0
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const backlog = target.current - cur
      if (backlog <= 0) {
        // Idle time must not bank into a burst when the next chunk lands.
        budget = 0
      } else {
        budget += dt * Math.max(CHARS_PER_SECOND, backlog / MAX_LAG_SECONDS)
        const n = Math.floor(budget)
        if (n > 0) {
          budget -= n
          cur = Math.min(target.current, cur + n)
          setShown(cur)
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [animate])

  return animate ? text.slice(0, shown) : text
}
