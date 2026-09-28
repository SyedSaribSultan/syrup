"use client"

import { useParams, useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { EngineProvider, useEngine, type EngineConnection } from "@/lib/engine-store"
import { openSandbox } from "@/lib/home"
import { PanelProvider } from "@/lib/panel"
import { useNow } from "@/lib/use-now"
import { Brew } from "./brew"
import { EgressEditor } from "./egress-editor"
import { NewChat } from "./new-chat"
import { SessionView } from "./session-view"
import { Workbench } from "./side-panel"
import { Sidebar } from "./sidebar"

/**
 * Cloud workspace: the same chat UI as local mode, mounted at once while the
 * sandbox opens (boots or wakes) in the background. A message sent before the
 * engine is up waits in the engine store and goes out when it connects. The
 * connection (URL + per-start password) lives only in this component's state.
 * Rendered by the /w/[id] layout, so it survives moving between the new-chat
 * screen and a chat.
 *
 * Lifecycle: a heartbeat while the tab is visible keeps the sandbox alive; a
 * lost event stream, a stopped sandbox reported by the heartbeat, or the
 * 45-minute session cap all lead back to open(), which resumes the same
 * files and the same OpenCode session.
 */

export type Heartbeat = { running: boolean; expiresAt: string | null; sessionStartedAt: string | null; sessionCapMs: number }

const HEARTBEAT_MS = 60_000

export function WorkspaceView({ workspaceId, egressAllow, hasKeys }: { workspaceId: string; egressAllow: string[]; hasKeys: boolean }) {
  const sessionId = useParams<{ sid?: string }>()?.sid
  const [conn, setConn] = useState<EngineConnection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [start, setStart] = useState<"cold" | "warm" | "hot" | null>(null)
  const [beat, setBeat] = useState<Heartbeat | null>(null)
  const [reopening, setReopening] = useState(false)
  const opening = useRef(false)
  const ready = conn !== null

  const open = useCallback(
    async (reason: "initial" | "reopen" = "initial") => {
      if (opening.current) return
      opening.current = true
      if (reason === "reopen") setReopening(true)
      setError(null)
      try {
        const c = await openSandbox(workspaceId, reason === "reopen")
        setStart(c.start)
        setConn({ baseUrl: c.baseUrl, headers: { authorization: c.authorization }, directory: c.directory })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setReopening(false)
        opening.current = false
      }
    },
    [workspaceId],
  )

  useEffect(() => {
    const t = setTimeout(() => void open("initial"), 0)
    return () => clearTimeout(t)
  }, [open])

  // Heartbeat while the tab is visible. Background tabs let the sandbox idle-stop; the next look wakes it.
  useEffect(() => {
    if (!ready) return
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
  }, [ready, workspaceId, open])

  const retry = () => void open(ready ? "reopen" : "initial")

  return (
    <EngineProvider connection={conn} remote>
      <PanelProvider workspaceId={workspaceId}>
        <ConnectionWatch onLost={() => void open("reopen")} />
        <AbortOnUnload />
        <div className="flex h-full min-h-0 flex-1">
          <Sidebar status={<SandboxStatus ready={ready} start={start} beat={beat} reopening={reopening} failed={!!error} />} footer={<SandboxControls workspaceId={workspaceId} egressAllow={egressAllow} />} />
          <main className="relative flex min-w-0 flex-1 flex-col">
            <SessionCapNotice beat={beat} />
            {error && sessionId && <OpenError error={error} onRetry={retry} />}
            <Workbench>{sessionId ? <SessionView id={sessionId} /> : <NewChat hrefFor={(id) => `/w/${workspaceId}/s/${id}`} noKeys={!hasKeys} error={error} onRetry={retry} />}</Workbench>
          </main>
        </div>
      </PanelProvider>
    </EngineProvider>
  )
}

/** One line under the switcher: whether the sandbox is running and when it sleeps. */
function SandboxStatus({ ready, start, beat, reopening, failed }: { ready: boolean; start: "cold" | "warm" | "hot" | null; beat: Heartbeat | null; reopening: boolean; failed: boolean }) {
  const { connected } = useEngine()
  const now = useNow(30_000)
  const idleMin = beat?.expiresAt && now ? Math.max(1, Math.round((new Date(beat.expiresAt).getTime() - now) / 60_000)) : null
  return (
    <div className="px-5 pb-2 text-[11px] text-muted" title={start ? `Last start: ${start}` : undefined}>
      {failed ? (
        <span className="text-err">Didn&apos;t start · try again</span>
      ) : !ready || reopening ? (
        <Brew mood="wake" timerAfter={10} className="text-[11px]!" />
      ) : !connected ? (
        <Brew mood="connect" timerAfter={10} className="text-[11px]!" />
      ) : beat?.running === false ? (
        "Stopped · wakes on your next message"
      ) : idleMin ? (
        `Running · sleeps after ${idleMin} min idle`
      ) : (
        "Running"
      )}
    </div>
  )
}

/** The sandbox could not open. Non-blocking: the chat stays readable and anything typed waits for the retry. */
function OpenError({ error, onRetry }: { error: string; onRetry(): void }) {
  return (
    <div className="flex items-center gap-2 border-b border-err/30 bg-err/5 px-5 py-2 text-[12px] text-ink-2">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-err" />
      <span className="min-w-0 flex-1 truncate" title={error}>
        <span className="font-medium text-err">Your workspace didn&apos;t start.</span> {error}
      </span>
      <button type="button" onClick={onRetry} className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink">
        Try again
      </button>
    </div>
  )
}

function SandboxControls({ workspaceId, egressAllow }: { workspaceId: string; egressAllow: string[] }) {
  const router = useRouter()
  const [stopping, setStopping] = useState(false)

  async function stop() {
    if (!window.confirm("Stop this workspace's sandbox now? Your files and chats are kept; the next message wakes it again.")) return
    setStopping(true)
    await fetch(`/api/workspaces/${workspaceId}/stop`, { method: "POST" })
    router.push("/")
  }

  return (
    <>
      <EgressEditor workspaceId={workspaceId} initial={egressAllow} />
      <div className="border-t border-line p-2">
        <button type="button" onClick={() => void stop()} disabled={stopping} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-2 transition hover:bg-surface/70 hover:text-ink disabled:opacity-50">
          {stopping ? "Stopping…" : "Stop workspace"}
        </button>
      </div>
    </>
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
  const busyKey = Object.entries(status)
    .filter(([, s]) => s.type === "busy" || s.type === "retry")
    .map(([id]) => id)
    .join(",")
  useEffect(() => {
    if (!busyKey) return
    const ids = busyKey.split(",")
    const onUnload = () => {
      for (const id of ids) void abort(id)
    }
    window.addEventListener("pagehide", onUnload)
    return () => window.removeEventListener("pagehide", onUnload)
  }, [busyKey, abort])
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
