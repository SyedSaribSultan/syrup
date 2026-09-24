"use client"

import { useEffect, useState } from "react"

/** Current time, refreshed on an interval. Null on the first render so rendering stays pure. */
export function useNow(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0)
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [intervalMs])
  return now
}
