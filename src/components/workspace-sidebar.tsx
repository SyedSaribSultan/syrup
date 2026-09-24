"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { useEngine } from "@/lib/engine-store"
import { fmtRelative } from "@/lib/format"
import { useLogs } from "./logs-modal"

/** Cloud workspace sidebar: this workspace's chats, plus stop/back. Mirrors the local Sidebar without the folder picker. */
export function WorkspaceSidebar({ workspaceId, name, sessionId, start }: { workspaceId: string; name: string; sessionId?: string; start: "cold" | "warm" | "hot" | null }) {
  const { sessions, sessionsLoaded, status, connected, renameSession, deleteSession } = useEngine()
  const { open: openLogs } = useLogs()
  const router = useRouter()
  const [stopping, setStopping] = useState(false)

  const list = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => !s.parentID)
        .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
    [sessions],
  )

  async function rename(id: string, current: string) {
    const title = window.prompt("Rename chat", current)
    if (title && title.trim() && title.trim() !== current) await renameSession(id, title.trim())
  }

  async function remove(id: string, title: string) {
    if (!window.confirm(`Delete "${title || "Untitled"}"? This cannot be undone.`)) return
    await deleteSession(id)
    if (sessionId === id) router.push(`/w/${workspaceId}`)
  }

  async function stop() {
    if (!window.confirm("Stop this workspace's sandbox now? Your files and chats are kept; the next message wakes it again.")) return
    setStopping(true)
    await fetch(`/api/workspaces/${workspaceId}/stop`, { method: "POST" })
    router.push("/workspaces")
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-surface-2/60">
      <div className="px-4 pt-4 pb-2">
        <Link href="/workspaces" className="text-[11px] text-muted hover:text-ink">
          ← Workspaces
        </Link>
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="min-w-0 truncate font-serif text-[1.15rem] font-semibold tracking-tight text-ink">{name}</div>
          <span title={connected ? `Connected (${start ?? "ready"})` : "Reconnecting…"} className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-ok" : "bg-warn pulse"}`} />
        </div>
      </div>

      <div className="px-3 pb-2">
        <Link href={`/w/${workspaceId}`} className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink shadow-card transition hover:border-line-2">
          <span className="text-accent">+</span> New chat
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Chats</div>
        {sessionsLoaded && list.length === 0 && <div className="px-2 py-3 text-sm text-muted">No chats in this workspace yet.</div>}
        <ul className="space-y-0.5">
          {list.map((s) => {
            const active = sessionId === s.id
            const busy = status[s.id]?.type === "busy" || status[s.id]?.type === "retry"
            return (
              <li key={s.id} className="group relative">
                <Link href={`/w/${workspaceId}/s/${s.id}`} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 pr-14 text-sm transition ${active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"}`}>
                  <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                  {busy ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent pulse" /> : <span className="shrink-0 text-[11px] text-muted group-hover:hidden">{fmtRelative(s.time.updated ?? s.time.created)}</span>}
                </Link>
                <div className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex">
                  <IconBtn title="Rename" onClick={() => void rename(s.id, s.title ?? "")}>
                    <path d="M2.5 11.5h9M8.6 2.9l2 2-6.1 6.1H2.5v-2l6.1-6.1Z" />
                  </IconBtn>
                  <IconBtn title="Delete" onClick={() => void remove(s.id, s.title ?? "")} danger>
                    <path d="M3 4h8M5.5 4V2.5h3V4M4 4l.6 7.5h4.8L10 4" />
                  </IconBtn>
                </div>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="space-y-0.5 border-t border-line p-2">
        <button type="button" onClick={openLogs} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-2 transition hover:bg-surface/70 hover:text-ink">
          Logs
        </button>
        <button type="button" onClick={() => void stop()} disabled={stopping} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-2 transition hover:bg-surface/70 hover:text-ink disabled:opacity-50">
          {stopping ? "Stopping…" : "Stop workspace"}
        </button>
      </div>
    </aside>
  )
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick(): void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.preventDefault()
        onClick()
      }}
      className={`rounded p-1 text-muted transition hover:bg-surface-2 ${danger ? "hover:text-err" : "hover:text-ink"}`}
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}
