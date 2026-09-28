"use client"

import { useCallback, useEffect, useState } from "react"

export type Rating = 1 | -1
/** The model that really answered: for Auto/Fast the router's pick, with the alias kept. */
export type RatedModel = { alias: string | null; providerId: string | null; modelId: string | null }

/**
 * The thumbs given in one chat, and a setter that saves optimistically
 * (reverting if the save fails). Same API in both modes: /api/feedback.
 */
export function useFeedback(sessionId: string) {
  const [state, setState] = useState<{ sessionId: string; ratings: Record<string, Rating> }>({ sessionId, ratings: {} })

  useEffect(() => {
    let cancelled = false
    fetch(`/api/feedback?session=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { ratings?: Record<string, Rating> } | null) => {
        if (!cancelled && b?.ratings) setState({ sessionId, ratings: b.ratings })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const ratings = state.sessionId === sessionId ? state.ratings : {}

  const rate = useCallback(
    (messageId: string, rating: Rating | 0, model: RatedModel) => {
      let before: Rating | undefined
      const put = (value: Rating | 0 | undefined, remember = false) =>
        setState((s) => {
          const next = { ...(s.sessionId === sessionId ? s.ratings : {}) }
          if (remember) before = next[messageId]
          if (value) next[messageId] = value
          else delete next[messageId]
          return { sessionId, ratings: next }
        })
      put(rating, true)
      fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, messageId, rating, ...model }) })
        .then((r) => {
          if (!r.ok) put(before)
        })
        .catch(() => put(before))
    },
    [sessionId],
  )

  return { ratings, rate }
}
