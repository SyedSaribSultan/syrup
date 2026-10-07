"use client"

import posthog from "posthog-js"
import { useEffect, useReducer, useRef, useState } from "react"
import { useEngine } from "@/lib/engine-store"
import { Brew } from "./brew"

/**
 * What the new-chat screen shows while the workspace is not ready yet.
 *
 * Two real stages, named as they happen: the sandbox starting (cloud; the
 * engine connection arrives), then the engine building its per-folder
 * instance (both modes; the session list arrives). The estimate comes from
 * this browser's last few waits, so it is honest and gets better with use.
 * Design notes in docs/ARCHITECTURE.md ("Warm-up").
 *
 * A small one-button game sits under the status after a few seconds, on a
 * mouse/trackpad only: not a modal, never over the composer, closes itself
 * the moment the workspace is ready, and stays away once dismissed.
 */

const HISTORY_KEY = "syrup.warmup.history"
const GAME_KEY = "syrup.warmup.game"
/** Below this the wait is a blink; nothing is shown. */
const SHOW_AFTER_MS = 1_200
/** The game only joins waits that are clearly long. */
const GAME_AFTER_MS = 3_000
const DEFAULT_ESTIMATE_MS = 10_000

function readHistory(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]")
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && x > 0).slice(-5) : []
  } catch {
    return []
  }
}

function remember(ms: number) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([...readHistory(), ms].slice(-5)))
  } catch {}
}

function estimate(history: number[]): number {
  if (history.length === 0) return DEFAULT_ESTIMATE_MS
  const s = [...history].sort((a, b) => a - b)
  return s[s.length >> 1]
}

function capture(event: string, props: Record<string, unknown>) {
  try {
    if (posthog.__loaded) posthog.capture(event, props)
  } catch {}
}

type Clock = { episode: number; start: number; now: number }

/** Ticks arrive from a timer; a tick from a new wait (episode) restarts the clock. */
function clockReducer(s: Clock, a: { episode: number; now: number }): Clock {
  return s.episode === a.episode ? { ...s, now: a.now } : { episode: a.episode, start: a.now, now: a.now }
}

export function useWarmup(): { waiting: boolean; stage: "workspace" | "engine" | null; elapsedMs: number; estimateMs: number } {
  const { ready, sessionsLoaded } = useEngine()
  const waiting = !ready || !sessionsLoaded
  const stage = !ready ? "workspace" : !sessionsLoaded ? "engine" : null
  const [history] = useState<number[]>(() => (typeof window === "undefined" ? [] : readHistory()))
  const [clock, tick] = useReducer(clockReducer, { episode: 0, start: 0, now: 0 })

  // While waiting, a timer reports the time twice a second; each wait is its own episode so the clock restarts.
  useEffect(() => {
    if (!waiting) return
    const episode = Date.now()
    const t = setInterval(() => tick({ episode, now: Date.now() }), 500)
    const first = setTimeout(() => tick({ episode, now: Date.now() }), 0)
    return () => {
      clearInterval(t)
      clearTimeout(first)
    }
  }, [waiting])

  // When a wait ends, its length joins the estimate for next time.
  const startedAt = useRef<number | null>(null)
  useEffect(() => {
    if (waiting) {
      startedAt.current ??= Date.now()
      return
    }
    if (startedAt.current) {
      const ms = Date.now() - startedAt.current
      startedAt.current = null
      if (ms >= SHOW_AFTER_MS) {
        remember(ms)
        capture("warmup_ready", { wait_ms: ms })
      }
    }
  }, [waiting])

  const elapsedMs = waiting && clock.start ? clock.now - clock.start : 0
  return { waiting, stage, elapsedMs, estimateMs: estimate(history) }
}

/** The status line: stage name, elapsed time, and the usual length of this wait. */
export function WarmupStatus({ queued }: { queued?: boolean }) {
  const { waiting, stage, elapsedMs, estimateMs } = useWarmup()
  if (!waiting || elapsedMs < SHOW_AFTER_MS) return null
  const over = elapsedMs > estimateMs * 1.5
  const label = stage === "workspace" ? "Starting your workspace" : "Starting the engine"
  const usual = `usually ~${Math.max(3, Math.round(estimateMs / 1000))} s`
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Brew mood="wake" label={label} timerAfter={0} />
        <span className="text-[12px] text-muted">
          {over ? "Taking longer than usual, still on it" : usual}
          {stage === "workspace" && " · then the engine, ~3 s"}
        </span>
      </div>
      {queued && <div className="text-[12px] text-muted">Your message is queued and goes out the moment it&apos;s ready.</div>}
      <WarmupGameSlot elapsedMs={elapsedMs} />
    </div>
  )
}

/** Mounts the game on a mouse/trackpad after a few seconds, unless the user has closed it before. */
function WarmupGameSlot({ elapsedMs }: { elapsedMs: number }) {
  // Read once: this only renders after a few seconds of waiting, so there is no server/client mismatch to worry about.
  const [enabled, setEnabled] = useState(() => {
    try {
      return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches && localStorage.getItem(GAME_KEY) !== "off"
    } catch {
      return false
    }
  })
  if (!enabled || elapsedMs < GAME_AFTER_MS) return null
  return (
    <WarmupGame
      onClose={() => {
        try {
          localStorage.setItem(GAME_KEY, "off")
        } catch {}
        capture("warmup_dismissed", { at_ms: elapsedMs })
        setEnabled(false)
      }}
    />
  )
}

// ---------------------------------------------------------------- the game

const W = 320
const H = 110
const GROUND = 86
const GRAVITY = 0.0032
const JUMP = -0.95
const SPEED0 = 0.16

type Blob = { x: number; w: number; h: number }

/**
 * A spoon hops over syrup spills. One input (space, ↑, click or tap on the
 * canvas). Pure canvas, no dependencies; colours come from the surrounding
 * text colour so it fits both themes.
 */
function WarmupGame({ onClose }: { onClose(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [score, setScore] = useState(0)
  const [best, setBest] = useState(0)
  const played = useRef(false)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext("2d")
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    el.width = W * dpr
    el.height = H * dpr
    ctx.scale(dpr, dpr)
    const styles = getComputedStyle(el)
    const ink = styles.color
    const soft = styles.getPropertyValue("--muted").trim() || ink

    let y = GROUND
    let vy = 0
    let blobs: Blob[] = []
    let nextIn = 900
    let speed = SPEED0
    let t0 = performance.now()
    let dead = false
    let points = 0
    let raf = 0
    let shownAt: number | null = null

    const reset = () => {
      y = GROUND
      vy = 0
      blobs = []
      nextIn = 900
      speed = SPEED0
      dead = false
      points = 0
      setScore(0)
    }
    const jump = () => {
      if (dead) return reset()
      if (y >= GROUND - 0.5) vy = JUMP
      if (!played.current) {
        played.current = true
        capture("warmup_played", {})
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        // Only when the user is not typing: the composer keeps the keyboard.
        const tag = (document.activeElement as HTMLElement | null)?.tagName
        if (tag === "TEXTAREA" || tag === "INPUT") return
        e.preventDefault()
        jump()
      }
    }
    el.addEventListener("pointerdown", jump)
    window.addEventListener("keydown", onKey)

    const draw = (now: number) => {
      const dt = Math.min(40, now - t0)
      t0 = now
      if (!dead) {
        vy += GRAVITY * dt
        y = Math.min(GROUND, y + vy * dt)
        if (y === GROUND) vy = 0
        nextIn -= dt
        if (nextIn <= 0) {
          blobs.push({ x: W + 10, w: 14 + Math.random() * 14, h: 10 + Math.random() * 10 })
          nextIn = 700 + Math.random() * 900
        }
        for (const b of blobs) b.x -= speed * dt
        const passed = blobs.filter((b) => b.x + b.w < 0).length
        if (passed) {
          points += passed
          speed = Math.min(0.34, speed + 0.006 * passed)
          setScore(points)
          setBest((v) => Math.max(v, points))
        }
        blobs = blobs.filter((b) => b.x + b.w >= 0)
        const sx = 40
        for (const b of blobs) {
          if (b.x < sx + 9 && b.x + b.w > sx - 9 && y > GROUND - b.h + 2) dead = true
        }
      }
      ctx.clearRect(0, 0, W, H)
      // ground
      ctx.globalAlpha = 0.35
      ctx.fillStyle = soft
      ctx.fillRect(0, GROUND + 9, W, 1)
      // spills
      ctx.globalAlpha = 0.85
      ctx.fillStyle = "#c98a2a"
      for (const b of blobs) {
        ctx.beginPath()
        ctx.ellipse(b.x + b.w / 2, GROUND + 9 - b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2)
        ctx.fill()
      }
      // spoon: bowl + handle
      ctx.globalAlpha = 1
      ctx.fillStyle = ink
      ctx.beginPath()
      ctx.ellipse(40, y, 9, 7, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillRect(38, y - 24, 4, 20)
      if (dead) {
        ctx.globalAlpha = 0.9
        ctx.font = "12px system-ui, sans-serif"
        ctx.fillStyle = ink
        ctx.fillText("Sticky. Tap or press space to try again.", 60, 30)
      }
      if (shownAt === null) shownAt = now
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener("pointerdown", jump)
      window.removeEventListener("keydown", onKey)
    }
  }, [])

  return (
    <div className="inline-block rounded-xl border border-line bg-surface/70 p-2 text-ink-2 select-none">
      <div className="mb-1 flex items-center gap-3 px-1 text-[11px] text-muted">
        <span>Hop the spills · space or click</span>
        <span className="flex-1" />
        <span className="tabular-nums">
          {score}
          {best > score ? ` · best ${best}` : ""}
        </span>
        <button type="button" onClick={onClose} aria-label="Close the game and don't show it again" title="Don't show this again" className="rounded px-1 text-muted transition hover:text-ink">
          ×
        </button>
      </div>
      <canvas ref={canvas} style={{ width: W, height: H }} className="block rounded-lg bg-bg/60" aria-label="Warm-up game: a spoon hopping over syrup spills" />
    </div>
  )
}
