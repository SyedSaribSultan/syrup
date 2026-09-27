"use client"

import { useEffect, useState, type CSSProperties } from "react"

/**
 * syrup's one waiting state: an animated drip plus a rotating word from the
 * kitchen. Every wait in the app uses this so they feel like the same product.
 * Words stay short and calm; the elapsed timer only appears on long waits.
 * The tick lives here, so a parent never re-renders because a Brew is running.
 */

export const BREW_WORDS = {
  think: ["Steeping", "Simmering", "Mulling it over", "Tasting", "Letting it thicken", "Reading the recipe"],
  work: ["Pouring", "Stirring", "Whisking", "Drizzling", "Folding it in", "Reducing"],
  wake: ["Warming the pan", "Heating up", "Uncorking", "Getting the stove going"],
  load: ["Scooping", "Fetching the jar", "Measuring out", "Opening the pantry"],
  save: ["Bottling", "Sealing"],
  connect: ["Finding the kitchen", "Lighting the burner"],
} as const

export type BrewMood = keyof typeof BREW_WORDS

const ROTATE_MS = 2600

type Props = {
  mood?: BrewMood
  /** Fixed label instead of rotating words, e.g. a real step name. */
  label?: string
  /** Show "· 12s" after this many seconds. 0 disables. */
  timerAfter?: number
  /** Epoch ms the wait began, so the timer survives remounts. Defaults to mount time. */
  since?: number
  size?: "sm" | "md"
  /** "inherit" takes the parent's color and font size (e.g. inside an accent button) and drops the shimmer. */
  tone?: "muted" | "inherit"
  className?: string
}

export function Brew({ mood = "work", label, timerAfter = 5, since, size = "sm", tone = "muted", className = "" }: Props) {
  const words = BREW_WORDS[mood]
  const timed = timerAfter > 0
  const rotates = !label && words.length > 1
  const period = timed ? 1000 : ROTATE_MS
  const [t, setT] = useState({ ms: 0, secs: 0 })

  useEffect(() => {
    if (!timed && !rotates) return
    const start = since ?? Date.now()
    const id = setInterval(() => setT((p) => ({ ms: p.ms + period, secs: Math.max(0, Math.floor((Date.now() - start) / 1000)) })), period)
    return () => clearInterval(id)
  }, [timed, rotates, period, since])

  const word = label ?? words[Math.floor(t.ms / ROTATE_MS) % words.length]
  const big = size === "md"
  const inherit = tone === "inherit"
  return (
    <span role="status" aria-label={label ?? words[0]} className={`brew inline-flex items-center ${inherit ? "gap-1.5" : `gap-2 text-muted ${big ? "text-sm" : "text-[13px]"}`} ${className}`}>
      <Drip size={big ? 16 : 13} className={inherit ? "text-current" : undefined} />
      <span key={word} aria-hidden className={inherit ? "brew-word" : "brew-word brew-shimmer"}>
        {word}…
      </span>
      {timed && t.secs >= timerAfter && (
        <span aria-hidden className="tabular-nums text-[11px] opacity-70">
          · {fmtWait(t.secs)}
        </span>
      )}
    </span>
  )
}

/** Just the "12s" of a long wait, for rows that show the Brew and the time in different places. */
export function Elapsed({ since, after = 5, className = "" }: { since?: number; after?: number; className?: string }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const start = since ?? Date.now()
    const id = setInterval(() => setSecs(Math.max(0, Math.floor((Date.now() - start) / 1000))), 1000)
    return () => clearInterval(id)
  }, [since])
  if (secs < after) return null
  return <span className={`tabular-nums ${className}`}>{fmtWait(secs)}</span>
}

function fmtWait(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

/** A drop of syrup falling from a spoon edge. Accent-colored, calm, respects reduced motion. */
export function Drip({ size = 13, className = "text-accent" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={`shrink-0 ${className}`}>
      <path d="M2.5 3.2h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      <path className="brew-drop" d="M8 4.2c0 0 2.6 3.2 2.6 5.1a2.6 2.6 0 0 1-5.2 0C5.4 7.4 8 4.2 8 4.2Z" fill="currentColor" />
    </svg>
  )
}

/** One last drop that lands and spreads out, played once when a long wait finishes. Pure CSS, gone after 700 ms. */
export function DripLand({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={`brew-landed pointer-events-none shrink-0 text-accent ${className}`}>
      <path className="brew-land" d="M8 4.2c0 0 2.6 3.2 2.6 5.1a2.6 2.6 0 0 1-5.2 0C5.4 7.4 8 4.2 8 4.2Z" fill="currentColor" />
    </svg>
  )
}

/** A placeholder bar shaped like the content it stands in for. Wrap groups in `.skel-in` so fast loads never flash. */
export function Skel({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden style={style} className={`skel block rounded-md ${className}`} />
}
