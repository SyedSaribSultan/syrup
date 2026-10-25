"use client"

import { Button, Icon } from "./ui/s"
import { useParams, useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { EngineProvider, useEngine, type EngineConnection } from "@/lib/engine-store"
import { openSandbox } from "@/lib/home"
import { PanelProvider } from "@/lib/panel"
import { useNow } from "@/lib/use-now"
import { Brew } from "./brew"
import { EgressEditor } from "./egress-editor"
import { AppShell } from "./app-shell"
import { NewChat } from "./new-chat"
import { SessionView } from "./session-view"
import { Workbench } from "./side-panel"
import { Sidebar } from "./sidebar"
import { confirmDialog } from "./ui/dialog"

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
        <AppShell sidebar={<Sidebar status={<SandboxStatus ready={ready} start={start} beat={beat} reopening={reopening} failed={!!error} />} footer={<SandboxControls workspaceId={workspaceId} egressAllow={egressAllow} />} />}>
          <SessionCapNotice beat={beat} />
          {error && sessionId && <OpenError error={error} onRetry={retry} />}
          <Workbench>{sessionId ? <SessionView id={sessionId} /> : <NewChat hrefFor={(id) => `/w/${workspaceId}/s/${id}`} noKeys={!hasKeys} error={error} onRetry={retry} />}</Workbench>
        </AppShell>
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
    <div className="s-meta px-4" title={start ? `Last start: ${start}` : undefined}>
      {failed ? (
        <span className="text-err">Didn&apos;t start. Try again.</span>
      ) : !ready || reopening ? (
        <Brew mood="wake" timerAfter={10} className="text-2xs!" />
      ) : !connected ? (
        <Brew mood="connect" timerAfter={10} className="text-2xs!" />
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
    <div role="alert" className="s-alert s-alert--critical s-alert--banner mx-4 mt-3 w-auto items-center">
      <Icon name="circle-alert" />
      <div className="s-alert__body min-w-0">
        <p className="s-alert__title">Your workspace didn&apos;t start.</p>
        <p className="s-alert__desc w-full truncate" title={error}>
          {error}
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

function SandboxControls({ workspaceId, egressAllow }: { workspaceId: string; egressAllow: string[] }) {
  const router = useRouter()
  const [stopping, setStopping] = useState(false)

  async function stop() {
    if (!(await confirmDialog({ title: "Stop this workspace's sandbox now?", body: "Your files and chats are kept; the next message wakes it again.", confirmLabel: "Stop" }))) return
    setStopping(true)
    await fetch(`/api/workspaces/${workspaceId}/stop`, { method: "POST" })
    router.push("/")
  }

  return (
    <>
      <EgressEditor workspaceId={workspaceId} initial={egressAllow} />
      <button type="button" onClick={() => void stop()} disabled={stopping} className="s-menu__item gap-3">
        <Icon name="close" size={16} />
        <span className="s-menu__text">{stopping ? "Stopping…" : "Stop workspace"}</span>
      </button>
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
    <div role="status" className="s-alert s-alert--warning s-alert--banner mx-4 mt-3 w-auto">
      <Icon name="triangle-alert" />
      <p className="s-alert__desc">
        This workspace will pause for a few seconds in about {Math.max(1, Math.round(left / 60_000))} min (platform session limit). Your files and chat continue afterwards.
      </p>
    </div>
  )
}
