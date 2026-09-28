"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Answer } from "@/lib/router-status"

/**
 * Read-only mode for the chat components (MessageView, PartView, FileLink):
 * set by the public share viewer and the HTML export, where there is no
 * engine. Inside it the components fetch nothing, start no timers, type
 * nothing out, render file mentions as plain text and take the router answers
 * from the snapshot instead of /api/router/answers.
 */

type ReadOnly = { answers: Answer[] }

const ReadOnlyContext = createContext<ReadOnly | null>(null)

export function ReadOnlyProvider({ answers, children }: { answers: Answer[]; children: ReactNode }) {
  const value = useMemo(() => ({ answers }), [answers])
  return <ReadOnlyContext.Provider value={value}>{children}</ReadOnlyContext.Provider>
}

/** Null in the live app. */
export function useReadOnly(): ReadOnly | null {
  return useContext(ReadOnlyContext)
}
