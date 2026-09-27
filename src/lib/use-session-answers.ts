"use client"

import { useEffect, useRef, useState } from "react"
import { backendKey, type Answer, type AnswersResponse } from "./router-status"

/** When the router received the request; `ts` is written when it ends. */
export function answerStart(a: Answer): number {
  return a.ts - a.latencyMs
}

// OpenCode's small_model calls (the chat title) go to syrup/fast with the chat's session id but no tools, so their
// prompt is a fraction of a real step's, which always carries the agent prompt and tool schemas (20K+ tokens).
const SMALL_CALL_MAX_INPUT = 4_000

function isSmallCall(a: Answer, peers: readonly Answer[]): boolean {
  const input = a.inputTokens ?? 0
  if (a.alias !== "fast" || input <= 0) return false
  return input < SMALL_CALL_MAX_INPUT || peers.some((p) => (p.inputTokens ?? 0) >= 3 * input)
}

/**
 * The router answers behind one assistant message, oldest first: same alias, request started while the message was open.
 * A session runs one step at a time and each step's request starts after its message is created, so no answer matches two messages.
 */
export function answersFor(all: readonly Answer[] | null, alias: string, created: number, end: number): Answer[] {
  if (!all) return []
  const inside = all.filter((a) => a.alias === alias && answerStart(a) >= created && answerStart(a) <= end)
  return inside.filter((a) => !isSmallCall(a, inside)).sort((a, b) => answerStart(a) - answerStart(b))
}

/** The backend this chat's alias is currently on: the latest real step, ignoring title calls and broken streams. */
export function currentAnswer(all: readonly Answer[] | null, alias: string): Answer | null {
  if (!all) return null
  const mine = all.filter((a) => a.alias === alias)
  const real = mine.filter((a) => !isSmallCall(a, mine) && !a.partial)
  let last: Answer | null = null
  for (const a of real) if (!last || answerStart(a) > answerStart(last)) last = a
  return last
}

export type RouterSwitch =
  | { kind: "stopped"; to: Answer; from: Answer[] }
  | { kind: "escalated" | "unavailable"; to: Answer; from: Answer }
  | { kind: "retried"; to: Answer }

/** How the router changed models for one message, judged only against answers the chat showed. */
export function routerSwitch(mine: readonly Answer[], all: readonly Answer[], created: number): RouterSwitch | null {
  const to = mine[mine.length - 1]
  if (!to) return null
  const toKey = backendKey(to.providerId, to.modelId)
  const earlier = mine.slice(0, -1)
  // Several requests in one message only happen when a stream broke and the engine asked again.
  if (earlier.length > 0 && earlier.every((a) => a.partial)) {
    const from = earlier.filter((a) => backendKey(a.providerId, a.modelId) !== toKey)
    if (from.length > 0) return { kind: "stopped", to, from }
  }
  if (to.reason === "escalated" || (to.reason === "fallback" && to.attempts === 1)) {
    let prev: Answer | null = null
    for (const a of all) {
      if (a.alias !== to.alias || answerStart(a) >= created || isSmallCall(a, [])) continue
      if (!prev || answerStart(a) > answerStart(prev)) prev = a
    }
    if (prev && backendKey(prev.providerId, prev.modelId) !== toKey) return { kind: to.reason === "escalated" ? "escalated" : "unavailable", to, from: prev }
  }
  if (to.attempts > 1) return { kind: "retried", to }
  return null
}

// Per-session cache shared by every message of a chat, so a long chat makes one request, not one per message.
type Entry = { answers: Answer[] | null; inflight: Promise<void> | null; listeners: Set<(a: Answer[]) => void> }
const cache = new Map<string, Entry>()

function entryFor(sessionId: string): Entry {
  let e = cache.get(sessionId)
  if (!e) {
    e = { answers: null, inflight: null, listeners: new Set() }
    cache.set(sessionId, e)
  }
  return e
}

function load(sessionId: string): Promise<void> {
  const e = entryFor(sessionId)
  if (e.inflight) return e.inflight
  e.inflight = (async () => {
    try {
      const r = await fetch(`/api/router/answers?session=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
      if (!r.ok) return
      const body = (await r.json()) as AnswersResponse
      e.answers = body.answers
      for (const l of e.listeners) l(body.answers)
    } catch {
    } finally {
      e.inflight = null
    }
  })()
  return e.inflight
}

/**
 * Which real models answered in a session (router requests whose content reached the chat, oldest first).
 * Fetches once per session; refetches whenever `refreshKey` changes after mount
 * (pass something that changes when a message completes).
 */
export function useSessionAnswers(sessionId: string | undefined, refreshKey?: unknown): Answer[] | null {
  const [state, setState] = useState<{ sessionId?: string; answers: Answer[] | null }>(() => ({ sessionId, answers: sessionId ? (cache.get(sessionId)?.answers ?? null) : null }))

  useEffect(() => {
    if (!sessionId) return
    const e = entryFor(sessionId)
    const listener = (answers: Answer[]) => setState({ sessionId, answers })
    e.listeners.add(listener)
    return () => {
      e.listeners.delete(listener)
    }
  }, [sessionId])

  // First mount loads when nothing is cached; later refreshKey changes always reload.
  const seen = useRef<{ sessionId: string; key: unknown } | null>(null)
  useEffect(() => {
    if (!sessionId) return
    const prev = seen.current
    seen.current = { sessionId, key: refreshKey }
    if (!prev || prev.sessionId !== sessionId) {
      if (!cache.get(sessionId)?.answers) void load(sessionId)
    } else if (!Object.is(prev.key, refreshKey)) {
      void load(sessionId)
    }
  }, [sessionId, refreshKey])

  if (!sessionId) return null
  return (state.sessionId === sessionId ? state.answers : null) ?? cache.get(sessionId)?.answers ?? null
}

/** Force a reload of one session's answers, e.g. from outside a message. */
export function refreshSessionAnswers(sessionId: string): void {
  void load(sessionId)
}
