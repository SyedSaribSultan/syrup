"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { Finding } from "@/lib/answer-checks"

/**
 * The quiet "numbers don't add up" note under a finished answer (docs/QUALITY.md Q3). The checks (src/lib/number-note.ts
 * over src/lib/answer-checks) load in their own chunk the first time a finished answer needs them and run when the
 * browser is idle; the note shows only once the answer has finished typing out. It never touches streaming, the first
 * token or the typewriter. Local and cloud render the same (one frontend); a shared snapshot shows none.
 *
 * While the check is pending it leaves an empty aria-busy marker, so the chat's after-turn follow (session-view.tsx)
 * keeps the answer's end in view until the note is in, and the UI harness waits for it.
 */

type Lib = typeof import("@/lib/number-note")
let loading: Promise<Lib> | null = null
/** The module once loaded, so a cached result renders in one pass (no placeholder title first). */
let loaded: Lib | null = null
const loadLib = () =>
  (loading ??= import("@/lib/number-note").then((m) => {
    loaded = m
    return m
  }))

/** Results by text: a chat opened again, or a message re-rendered, isn't checked twice. */
const cache = new Map<string, Finding[]>()
const CACHE_MAX = 300

function idle(fn: () => void): () => void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
  if (w.requestIdleCallback) {
    // Idle time, but soon: in a chat opened again the notes should be there almost at once.
    const id = w.requestIdleCallback(fn, { timeout: 200 })
    return () => w.cancelIdleCallback?.(id)
  }
  const t = setTimeout(fn, 0)
  return () => clearTimeout(t)
}

/** Where scroll anchoring is missing (WebKit): a note that just appeared above the view moves the view by its height. */
function holdView(note: HTMLElement): void {
  if (typeof CSS !== "undefined" && CSS.supports?.("overflow-anchor", "auto")) return
  let scroller: HTMLElement | null = note.parentElement
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
  if (!scroller) return
  const box = note.getBoundingClientRect()
  if (box.bottom <= scroller.getBoundingClientRect().top) scroller.scrollTop += box.height + (parseFloat(getComputedStyle(note).marginTop) || 0)
}

/** Whether the element still holds text typing out. */
const revealing = (el: Element | null | undefined) => !!el?.querySelector("[data-revealing]")

/**
 * `fresh`: the answer streamed in front of this page, so the note arrives later and fades in (MOTION.md §4.6, a
 * Notice). In a chat opened afterwards it is a static note present at load and shows at once (MOTION.md §2.9).
 */
export function NumberNote({ text, fresh = false, onFix }: { text: string; fresh?: boolean; onFix?: (prompt: string) => void }) {
  const [result, setResult] = useState<{ text: string; issues: Finding[] } | null>(null)
  const [typed, setTyped] = useState(false)
  const [sent, setSent] = useState(false)
  const sentRef = useRef(false)
  const marker = useRef<HTMLDivElement>(null)
  // A text checked before (this chat opened again, or the same words in another message) needs no second pass.
  const issues = result?.text === text ? result.issues : (cache.get(text) ?? null)

  // Check once per text, when the browser is idle.
  useEffect(() => {
    if (cache.has(text)) return
    let live = true
    let cancel = () => {}
    loadLib().then(
      (L) => {
        if (!live) return
        cancel = idle(() => {
          if (!live) return
          let found: Finding[] = []
          try {
            found = L.checkNumbers(text)
          } catch {
            // A checker bug never takes the chat with it.
          }
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
          cache.set(text, found)
          setResult({ text, issues: found })
        })
      },
      () => live && setResult({ text, issues: [] }),
    )
    return () => {
      live = false
      cancel()
    }
  }, [text])

  // Something to show: wait until the answer has finished typing out ([data-revealing] in this message).
  const waiting = !!issues?.length && !typed
  useEffect(() => {
    const host = marker.current?.parentElement
    if (!waiting || !host) return
    const finish = () => {
      if (revealing(host)) return false
      setTyped(true)
      return true
    }
    // On the next frame rather than in the effect itself, so the first paint never flashes the note.
    let frame = requestAnimationFrame(() => {
      frame = 0
      if (finish()) return
      mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-revealing"] })
    })
    const mo = new MutationObserver(() => {
      if (finish()) mo.disconnect()
    })
    return () => {
      cancelAnimationFrame(frame)
      mo.disconnect()
    }
  }, [waiting])

  // Never move what the reader is looking at. A note that appears above the view (a reader scrolled down past this
  // answer) pushes the text in view down by its height. Chromium and Firefox hold the view still themselves (CSS
  // scroll anchoring); WebKit has none, so there the scroller moves by the note's height before it paints.
  const shown = !!issues?.length && !waiting && !!loaded
  useLayoutEffect(() => {
    if (shown && marker.current) holdView(marker.current)
  }, [shown])

  if (!issues || waiting) return <div ref={marker} aria-busy="true" hidden />
  const L = loaded
  if (!issues.length || !L) return <div ref={marker} hidden />
  const fix = onFix && !sent && L.fixNumbersEnabled() ? onFix : null
  return (
    <div
      ref={marker}
      role="note"
      data-number-note
      {...(fresh ? { "data-state": "open", "data-side": "down" } : {})}
      className={`${fresh ? "motion-notice " : ""}mt-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-5 text-ink-2`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{L.noteTitle(issues)}</p>
          <ul className="mt-0.5 space-y-0.5 [overflow-wrap:anywhere]">
            {issues.map((f) => (
              <li key={f.message}>{f.message}</li>
            ))}
          </ul>
          {fix && (
            <button
              type="button"
              disabled={sent}
              onClick={() => {
                // A double click lands twice before the re-render hides the button: the ref sends once.
                if (sentRef.current) return
                sentRef.current = true
                setSent(true)
                fix(L.fixPrompt(issues))
              }}
              className="mt-1.5 rounded-md border border-line bg-bg px-2.5 py-1 text-[12px] font-medium text-ink transition hover:bg-surface-2 pointer-coarse:px-3 pointer-coarse:py-2"
            >
              Fix numbers
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
