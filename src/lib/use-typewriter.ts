"use client"

import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Markdown } from "@/components/markdown"
import type { FenceOrigin } from "@/components/rich/slot"
import { prefetchFor } from "@/lib/rich/lazy"

/**
 * A reply as it streams in (`LiveText`), loaded on first use: a chat only needs it once
 * this page watches a part from its first word (src/components/parts.tsx, which shows
 * finished text as plain Markdown). Three pieces:
 *
 * - **The typewriter** (a requestAnimationFrame loop). Text lands in bursts (one store
 *   update per animation frame, however many deltas arrived, and models pause and then
 *   send a lot at once); the reveal turns that into a steady flow that eases out after
 *   each burst and stays a fraction of a second behind the stream, so what the model
 *   has written is on screen almost as soon as it arrives. Whatever was there when it
 *   mounted (a chat switched back to) shows at once. Reduced motion: no animation.
 * - **Paced Markdown.** The growing text reaches Markdown at a pace the device can afford.
 * - **Settled blocks.** Only the growing tail is parsed again; finished blocks render once.
 */

// The slowest reveal: a slow model's text reads at this rhythm rather than in clumps.
const CHARS_PER_SECOND = 70
// While the text streams, the reveal trails it by about this long (the backlog is revealed at backlog / LAG per second).
const LAG_SECONDS = 0.25
// Once the text is complete, what is left appears within about this long.
const FINISH_SECONDS = 0.15
const FINISH_CHARS_PER_SECOND = 600

/** `live`: the text is still streaming in. Whether it animates at all is decided once, when this mounts. */
export function useTypewriter(text: string, live: boolean): string {
  const [animate] = useState(() => live && typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  const [shown, setShown] = useState(text.length)
  const target = useRef(text.length)
  const cur = useRef(text.length)
  const streaming = useRef(live)
  const raf = useRef(0)
  const prev = useRef(text)

  useEffect(() => {
    streaming.current = live
  }, [live])

  useEffect(() => {
    if (!animate) return
    // Text that no longer starts with what is on screen was replaced, not extended (a repaired block written back):
    // show it whole rather than type its tail out again.
    const replaced = !text.startsWith(prev.current.slice(0, cur.current))
    prev.current = text
    target.current = text.length
    if (replaced) {
      cancelAnimationFrame(raf.current)
      raf.current = 0
      cur.current = text.length
      setShown(cur.current)
      return
    }
    // The final text may differ from what streamed (an engine plugin can rewrite it); never point past its end.
    if (cur.current > target.current) {
      cur.current = target.current
      setShown(cur.current)
    }
    if (raf.current || cur.current >= target.current) return
    let last = performance.now()
    let budget = 0
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const backlog = target.current - cur.current
      if (backlog <= 0) {
        // Caught up: stop until the next burst, so idle time never banks into a jump.
        raf.current = 0
        return
      }
      const rate = streaming.current ? Math.max(CHARS_PER_SECOND, backlog / LAG_SECONDS) : Math.max(FINISH_CHARS_PER_SECOND, backlog / FINISH_SECONDS)
      budget += dt * rate
      const n = Math.floor(budget)
      if (n > 0) {
        budget -= n
        cur.current = Math.min(target.current, cur.current + n)
        setShown(cur.current)
      }
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }, [animate, text, live])

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  if (!animate) return text
  // Never cut an emoji (a UTF-16 surrogate pair) in half.
  const end = shown > 0 && shown < text.length && /[\uD800-\uDBFF]/.test(text[shown - 1]) ? shown + 1 : shown
  return text.slice(0, end)
}

/** The longest the growing text waits before Markdown shows it. */
const MAX_PACE_MS = 200

/**
 * While a reply grows, its Markdown is parsed again for every new piece. That is cheap for a short reply and costs
 * a slow phone tens of milliseconds for a long one, so the growing text reaches Markdown at a pace the device can
 * afford: right away while a render is cheap, then at most every few frames, keeping these renders to about a third
 * of the main thread. The finished text renders at once.
 */
export function useMarkdownPace(text: string, growing: boolean): string {
  const [shown, setShown] = useState(text)
  const cost = useRef(0)
  const last = useRef(0)
  const started = useRef(0)

  useEffect(() => {
    if (!growing || text === shown) return
    const wait = Math.max(0, last.current + Math.min(MAX_PACE_MS, cost.current * 2) - performance.now())
    const t = setTimeout(() => {
      started.current = performance.now()
      setShown(text)
    }, wait)
    return () => clearTimeout(t)
  }, [text, growing, shown])

  // How long the last render of the growing text took (scheduling to commit), smoothed.
  useLayoutEffect(() => {
    if (!started.current) return
    const now = performance.now()
    cost.current = cost.current ? cost.current * 0.6 + (now - started.current) * 0.4 : now - started.current
    last.current = now
    started.current = 0
  }, [shown])

  return growing ? shown : text
}

/**
 * A fence opener, as CommonMark reads one: three or more backticks whose info string holds no backtick (a line like
 * "```npm test``` runs it" is inline code in a paragraph), three or more tildes, or `$$` alone on its line (display math).
 */
const FENCE = /^ {0,3}(`{3,}(?![^`]*`)|~{3,}|\$\$(?=\s*$))/
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(\s|$)/
/**
 * Markdown whose meaning can reach across blank lines (reference links, footnotes), or a line of raw HTML (shown as
 * text, outside any paragraph, so it takes no block spacing in one render but would as a block of its own): never split.
 */
const SPANS_BLOCKS = /^ {0,3}(\[[^\]\n]+\]:|<[!/?a-z])/im

/**
 * Growing Markdown cut into top-level blocks that can no longer change, plus the growing tail (last). A cut goes
 * after a blank line outside any fence, before a complete line that starts at column 0 and isn't a list item (a
 * list item there may continue a loose list; an indented line may continue a list item or be indented code).
 * Whatever such a line starts, the blocks before it end there, so each renders alone exactly as it would in the whole.
 */
export function settledBlocks(text: string): string[] {
  if (SPANS_BLOCKS.test(text)) return [text]
  const out: string[] = []
  let start = 0
  let fence: string | null = null
  let blank = false
  let pos = 0
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos)
    // Only complete lines decide: the tail's last line may still become anything.
    if (nl < 0) break
    const line = text.slice(pos, nl)
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null
      blank = false
    } else if (!line.trim()) blank = true
    else {
      if (blank && pos > start && /^\S/.test(line) && !LIST_ITEM.test(line)) {
        out.push(text.slice(start, pos))
        start = pos
      }
      blank = false
      if (f) fence = f[1]
    }
    pos = nl + 1
  }
  out.push(text.slice(start))
  return out
}

/**
 * Streamed answer text: it types out (the typewriter is its arrival animation, so it gets no fade). One .md wraps
 * blocks that each render once complete, so only the last is parsed again; the spacing matches a single Markdown
 * render (.md > * + * spaces the blocks as it spaces their contents). The tree keeps that shape once the text is
 * finished too: switching to one Markdown render then would replace every node, and with them a selection the
 * reader made, a code block's sideways scroll or its "Copied" state. `data-revealing` marks text still typing out
 * (the chat keeps following it after the turn ends: src/components/session-view.tsx).
 *
 * `settled`: the reply will not grow any more (its part ended, or the session went idle: an aborted turn never gets
 * an end time). Only then, and once all of it shows, is the last block final, so a fence the model never closed is
 * drawn instead of waiting as a skeleton (docs/RENDERING.md §2.4). Blocks before the last are complete by construction.
 */
export function LiveText({ text, live, settled = !live, origin }: { text: string; live: boolean; settled?: boolean; origin?: FenceOrigin }) {
  const typed = useTypewriter(text, live)
  const growing = live || typed.length < text.length
  const paced = useMarkdownPace(typed, growing)
  const blocks = settledBlocks(paced)
  const final = settled && paced.length === text.length
  useEffect(() => prefetchFor(text), [text])
  return createElement(
    "div",
    { className: "chat-text", "data-revealing": growing ? "" : undefined },
    createElement(
      "div",
      { className: "md" },
      blocks.map((b, i) => createElement(Markdown, { key: i, text: b, final: i < blocks.length - 1 || final, origin })),
    ),
  )
}
