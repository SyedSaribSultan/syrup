"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { EngineProvider, useEngine, type EngineConnection } from "@/lib/engine-store"
import { useNow } from "@/lib/use-now"
import { NewChat } from "./new-chat"
import { SessionView } from "./session-view"
import { WorkspaceSidebar } from "./workspace-sidebar"

/**
 * Cloud workspace: opens (boots or wakes) the sandbox, then mounts the same
 * chat UI as local mode against it. The connection (URL + per-start password)
 * lives only in this component's state.
 *
 * Lifecycle: a heartbeat while the tab is visible keeps the sandbox alive; a
 * lost event stream, a stopped sandbox reported by the heartbeat, or the
 * 45-minute session cap all lead back to open(), which resumes the same
 * files and the same OpenCode session.
 */

type Phase = "opening" | "ready" | "error"
type OpenResponse = { connection: { baseUrl: string; authorization: string; directory: string; start: "cold" | "warm" | "hot"; ms: number; expiresAt: string | null } }
export type Heartbeat = { running: boolean; expiresAt: string | null; sessionStartedAt: string | null; sessionCapMs: number }

const HEARTBEAT_MS = 60_000

export function WorkspaceView({ workspaceId, name, sessionId }: { workspaceId: string; name: string; sessionId?: string }) {
  const [phase, setPhase] = useState<Phase>("opening")
  const [conn, setConn] = useState<EngineConnection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [start, setStart] = useState<"cold" | "warm" | "hot" | null>(null)
  const [beat, setBeat] = useState<Heartbeat | null>(null)
  const [reopening, setReopening] = useState(false)
  const opening = useRef(false)

  const open = useCallback(async (reason: "initial" | "reopen" = "initial") => {
    if (opening.current) return
    opening.current = true
    if (reason === "initial") setPhase("opening")
    else setReopening(true)
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
      setReopening(false)
      opening.current = false
    }
  }, [workspaceId])

  useEffect(() => {
    const t = setTimeout(() => void open("initial"), 0)
    return () => clearTimeout(t)
  }, [open])

  // Heartbeat while the tab is visible. Background tabs let the sandbox idle-stop; the next look wakes it.
  useEffect(() => {
    if (phase !== "ready") return
    let stopped = false
    async function beatOnce() {
      if (document.visibilityState !== "visible") return
      try {
        const r = await fetch(`/api/workspaces/${workspaceId}/heartbeat`, { method: "POST" })
        const j = (await r.json()) as Heartbeat
        if (stopped || !r.ok) return
        setBeat(j)
        if (!j.running) void open("reopen")
      } catch {}
    }
    void beatOnce()
    const t = setInterval(() => void beatOnce(), HEARTBEAT_MS)
    const onVisible = () => document.visibilityState === "visible" && void beatOnce()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      stopped = true
      clearInterval(t)
      document.removeEventListener("visibilitychange", onVisible)
    }
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
                <button type="button" onClick={() => void open("initial")} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink">
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
      <ConnectionWatch onLost={() => void open("reopen")} />
      <AbortOnUnload />
      <div className="flex h-full min-h-0 flex-1">
        <WorkspaceSidebar workspaceId={workspaceId} name={name} sessionId={sessionId} start={start} beat={beat} reopening={reopening} />
        <main className="relative flex min-w-0 flex-1 flex-col">
          <SessionCapNotice beat={beat} />
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

/** A closed tab should not keep a model generating: abort busy sessions on unload. */
function AbortOnUnload() {
  const { status, abort } = useEngine()
  const busy = Object.entries(status)
    .filter(([, s]) => s.type === "busy" || s.type === "retry")
    .map(([id]) => id)
  useEffect(() => {
    if (busy.length === 0) return
    const onUnload = () => {
      for (const id of busy) void abort(id)
    }
    window.addEventListener("pagehide", onUnload)
    return () => window.removeEventListener("pagehide", onUnload)
  }, [busy, abort])
  return null
}

/** Soft warning five minutes before the platform's 45-minute session cap. */
function SessionCapNotice({ beat }: { beat: Heartbeat | null }) {
  const now = useNow(30_000)
  if (!now || !beat?.running || !beat.sessionStartedAt) return null
  const left = new Date(beat.sessionStartedAt).getTime() + beat.sessionCapMs - now
  if (left > 5 * 60_000 || left < 0) return null
  return (
    <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/5 px-5 py-1.5 text-[12px] text-ink-2">
      <span className="h-1.5 w-1.5 rounded-full bg-warn" />
      This workspace will pause for a few seconds in about {Math.max(1, Math.round(left / 60_000))} min (platform session limit). Your files and chat continue afterwards.
    </div>
  )
}
