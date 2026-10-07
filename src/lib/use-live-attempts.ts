"use client"

import { useEffect, useState } from "react"
import type { AnswersResponse, Attempt } from "./router-status"

/** How often the waiting line asks what the router has tried so far. */
const POLL_MS = 2_000

/**
 * The router's attempts for a chat (failures included), refreshed every two
 * seconds while `active`. Powers the line under the "thinking" dots that says
 * which model is being tried and why the last one was dropped. Idle when the
 * chat is not waiting, so a finished chat costs nothing.
 */
export function useLiveAttempts(sessionId: string | undefined, active: boolean): Attempt[] {
  const [attempts, setAttempts] = useState<Attempt[]>([])
  useEffect(() => {
    if (!sessionId || !active) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const r = await fetch(`/api/router/answers?session=${encodeURIComponent(sessionId)}&live=1`, { cache: "no-store" })
        if (r.ok) {
          const body = (await r.json()) as AnswersResponse
          if (alive && body.attempts) setAttempts(body.attempts)
        }
      } catch {}
      if (alive) timer = setTimeout(() => void tick(), POLL_MS)
    }
    timer = setTimeout(() => void tick(), 1_200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [sessionId, active])
  return active ? attempts : []
}
