"use client"

import { useEffect, useRef, useState } from "react"
import type { Answer, AnswersResponse } from "./router-status"

// The matching logic is pure and shared with the share viewer and the transcript serializers.
export { answerStart, answersFor, currentAnswer, routerSwitch, type RouterSwitch } from "./router-answers"

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
