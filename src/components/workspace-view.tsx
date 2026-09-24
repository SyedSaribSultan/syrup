"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { EngineProvider, useEngine, type EngineConnection } from "@/lib/engine-store"
import { NewChat } from "./new-chat"
import { SessionView } from "./session-view"
import { WorkspaceSidebar } from "./workspace-sidebar"

/**
 * Cloud workspace: opens (boots or wakes) the sandbox, then mounts the same
 * chat UI as local mode against it. The connection (URL + per-start password)
 * lives only in this component's state. A heartbeat keeps the sandbox alive
 * while the tab is open; a lost event stream triggers a re-open.
 */

type Phase = "opening" | "ready" | "error"
type OpenResponse = { connection: { baseUrl: string; authorization: string; directory: string; start: "cold" | "warm" | "hot"; ms: number; expiresAt: string | null } }

const HEARTBEAT_MS = 60_000

export function WorkspaceView({ workspaceId, name, sessionId }: { workspaceId: string; name: string; sessionId?: string }) {
  const [phase, setPhase] = useState<Phase>("opening")
  const [conn, setConn] = useState<EngineConnection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [start, setStart] = useState<"cold" | "warm" | "hot" | null>(null)
  const opening = useRef(false)

  const open = useCallback(async () => {
    if (opening.current) return
    opening.current = true
    setPhase("opening")
    setError(null)
    const t0 = Date.now()
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500)
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/open`, { method: "POST" })
      const j = (await r.json()) as OpenResponse & { error?: string }
      if (!r.ok || !j.connection) throw new Error(j.error ?? `open failed (${r.status})`)
      setStart(j.connection.start)
      setConn({ baseUrl: j.connection.baseUrl, headers: { authorization: j.connection.authorization }, directory: j.connection.directory })
      setPhase("ready")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase("error")
    } finally {
      clearInterval(tick)
      opening.current = false
    }
  }, [workspaceId])

  useEffect(() => {
    const t = setTimeout(() => void open(), 0)
    return () => clearTimeout(t)
  }, [open])

  // Keep the sandbox from idle-stopping while this tab is open; re-open if it stopped anyway.
  useEffect(() => {
    if (phase !== "ready") return
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/workspaces/${workspaceId}/heartbeat`, { method: "POST" })
        const j = (await r.json()) as { expiresAt: string | null }
        if (r.ok && j.expiresAt === null) void open()
      } catch {}
    }, HEARTBEAT_MS)
    return () => clearInterval(t)
  }, [phase, workspaceId, open])

  if (phase !== "ready" || !conn) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-[440px] rounded-2xl border border-line bg-surface p-6 shadow-card">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{name}</div>
          {phase === "opening" ? (
            <>
              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-ink">
                <span className="h-2 w-2 rounded-full bg-accent pulse" />
                {elapsed < 4 ? "Waking your workspace…" : elapsed < 12 ? "Starting the agent…" : "First start takes a little longer: installing the engine and cloning the repository…"}
              </div>
              <div className="mt-1 text-xs text-muted">{elapsed}s · a warm workspace takes a few seconds, a brand-new one about fifteen.</div>
            </>
          ) : (
            <>
              <div className="mt-2 text-sm font-medium text-err">Could not start the workspace</div>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-code-bg p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{error}</pre>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => void open()} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink">
                  Try again
                </button>
                <Link href="/workspaces" className="rounded-lg border border-line bg-bg px-3 py-2 text-xs font-medium text-ink">
                  All workspaces
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <EngineProvider connection={conn}>
      <ConnectionWatch onLost={open} />
      <div className="flex h-full min-h-0 flex-1">
        <WorkspaceSidebar workspaceId={workspaceId} name={name} sessionId={sessionId} start={start} />
        <main className="relative flex min-w-0 flex-1 flex-col">
          {sessionId ? <SessionView id={sessionId} /> : <NewChat hrefFor={(id) => `/w/${workspaceId}/s/${id}`} title={`What are we building in ${name}?`} />}
        </main>
      </div>
    </EngineProvider>
  )
}

/** If the event stream stays down for 20 s the sandbox is gone (idle stop, 45-minute cap, rotated password): open it again. */
function ConnectionWatch({ onLost }: { onLost(): void }) {
  const { connected } = useEngine()
  const seen = useRef(false)
  useEffect(() => {
    if (connected) {
      seen.current = true
      return
    }
    if (!seen.current) return
    const t = setTimeout(onLost, 20_000)
    return () => clearTimeout(t)
  }, [connected, onLost])
  return null
}
