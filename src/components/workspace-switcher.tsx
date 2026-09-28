"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { hostOS, localFileAction } from "@/lib/file-actions"
import { Skel } from "./brew"
import { confirmDialog } from "./ui/dialog"
import { useDismiss } from "@/lib/use-dismiss"
import { MAX_WORKSPACES } from "@/lib/workspace-limits"
import { baseName, useAllChats, useWorkspaces, wsColor, wsTint, type WorkspaceItem } from "@/lib/workspaces"

type Browse = { path: string; exists: boolean; git?: boolean; parent: string | null; dirs: { name: string; path: string; git: boolean }[]; home?: string }

export function WorkspaceDot({ color, className = "" }: { color: number; className?: string }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${className}`} style={{ background: wsColor(color) }} />
}

/** Rounded square in the workspace's color with its initial: the workspace's identity in the switcher. */
export function WorkspaceTile({ name, color, size = 28 }: { name: string; color: number; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), background: wsTint(color), color: wsColor(color), boxShadow: `inset 0 0 0 1px ${wsTint(color, 32)}` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Last two path segments, e.g. …\repos\syrup. Repo and cloud details pass through. */
function shortDetail(detail: string): string {
  const sep = detail.includes("\\") ? "\\" : "/"
  const parts = detail.split(/[\\/]/).filter(Boolean)
  return /^[a-z]:|^\//i.test(detail) && parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : detail
}

export function WorkspaceSwitcher() {
  const { workspaces, activeId } = useWorkspaces()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = workspaces?.find((w) => w.id === activeId) ?? null

  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)

  return (
    <div ref={ref} className="relative px-3 pt-1 pb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={active?.detail}
        className={`flex w-full items-center gap-2.5 rounded-xl border bg-surface px-2.5 py-2 text-left shadow-card transition hover:border-line-2 ${open ? "border-line-2" : "border-line"}`}
      >
        {active ? <WorkspaceTile name={active.name} color={active.color} /> : <span className="h-7 w-7 shrink-0 rounded-lg border border-dashed border-line-2" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{active ? active.name : workspaces ? "Choose a workspace" : <Skel className="h-3 w-20" />}</span>
          <span className="block truncate text-[11px] text-muted">{active ? shortDetail(active.detail) : "No workspace open"}</span>
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 4.5 6 2l2.5 2.5M3.5 7.5 6 10l2.5-2.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-3 top-full z-30 mt-1.5 w-[328px] overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          <Menu onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

function Menu({ onDone }: { onDone(): void }) {
  const { mode, workspaces, activeId, full, open, remove, add } = useWorkspaces()
  const chats = useAllChats()
  const [browsing, setBrowsing] = useState(false)
  const counts = new Map<string, number>()
  for (const c of chats) counts.set(c.workspaceId, (counts.get(c.workspaceId) ?? 0) + 1)

  async function onRemove(w: WorkspaceItem) {
    const ok = await confirmDialog(
      mode === "cloud"
        ? { title: `Delete "${w.name}"?`, body: "This destroys its sandbox and every file in it. It cannot be undone. Its chats leave the list (the history stays in your account).", confirmLabel: "Delete", danger: true }
        : { title: `Remove "${w.name}" from syrup?`, body: "The folder and its files stay on disk. Its chats leave the list and come back if you add the folder again.", confirmLabel: "Remove" },
    )
    if (ok) await remove(w.id)
  }

  const [folderErr, setFolderErr] = useState<string | null>(null)
  const folderApp = hostOS() === "windows" ? "File Explorer" : hostOS() === "mac" ? "Finder" : "your file manager"
  async function onReveal(w: WorkspaceItem) {
    const err = await localFileAction(w.id, w.id, "open")
    setFolderErr(err === "missing" ? `${w.detail} no longer exists` : err)
  }

  if (browsing) return <FolderBrowser onBack={() => setBrowsing(false)} onChoose={(path) => void add({ path }).then((err) => !err && onDone())} />

  return (
    <div>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
        <span className="text-[13px] font-medium text-ink">Switch workspace</span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted" title={`Up to ${MAX_WORKSPACES} workspaces, one color each`}>
          <span className="flex gap-0.5">
            {Array.from({ length: MAX_WORKSPACES }, (_, i) => (
              <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < (workspaces?.length ?? 0) ? (full ? "bg-warn" : "bg-ink-2") : "bg-line-2"}`} />
            ))}
          </span>
          <span className={full ? "text-warn" : ""}>
            {workspaces?.length ?? 0} of {MAX_WORKSPACES}
          </span>
        </span>
      </div>
      <div className="max-h-[360px] space-y-0.5 overflow-y-auto p-1.5">
        {workspaces?.length === 0 && <div className="px-2 py-3 text-[13px] text-muted">No workspaces yet. Add one below.</div>}
        {workspaces?.map((w) => {
          const isActive = w.id === activeId
          const n = counts.get(w.id) ?? 0
          return (
            <div key={w.id} className={`group relative rounded-lg transition ${isActive ? "bg-surface-2" : "hover:bg-surface-2"}`}>
              <button
                type="button"
                onClick={() => {
                  open(w.id)
                  onDone()
                }}
                title={w.detail}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left"
              >
                <WorkspaceTile name={w.name} color={w.color} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ink">{w.name}</span>
                    {isActive && <span className="shrink-0 rounded bg-surface px-1 py-px text-[10px] font-medium text-ink-2 shadow-card">Current</span>}
                  </span>
                  <span className="block truncate text-[11px] text-muted">{shortDetail(w.detail)}</span>
                </span>
                <span className={`shrink-0 text-[11px] text-muted ${isActive && mode === "cloud" ? "" : "group-hover:invisible"}`}>
                  {n} {n === 1 ? "chat" : "chats"}
                </span>
              </button>
              {(mode === "local" || (!isActive && !w.home)) && (
                <span className="absolute top-1/2 right-2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex">
                  {mode === "local" && (
                    <button type="button" title={`Open folder in ${folderApp}`} aria-label="Open folder" onClick={() => void onReveal(w)} className="rounded-md p-1.5 text-muted transition hover:bg-surface hover:text-ink">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
                        <path d="M1.75 4.25c0-.55.45-1 1-1h3.1l1.5 1.5h5.9c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-8Z" />
                      </svg>
                    </button>
                  )}
                  {!isActive && !w.home && (
                    <button type="button" title={mode === "cloud" ? "Delete workspace" : "Remove from list"} onClick={() => void onRemove(w)} className="rounded-md p-1.5 text-muted transition hover:bg-surface hover:text-err">
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                        <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
                      </svg>
                    </button>
                  )}
                </span>
              )}
            </div>
          )
        })}
        {folderErr && <div className="px-2 pt-1 pb-0.5 text-[11px] text-warn">{folderErr}</div>}
      </div>
      <div className="border-t border-line bg-surface-2/40 p-1.5">
        {full ? (
          <div className="flex items-center gap-3 px-2 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-warn/50 text-[13px] text-warn">!</span>
            <span className="text-[12px] leading-snug text-ink-2">
              <span className="block font-medium text-ink">All {MAX_WORKSPACES} slots in use</span>
              Remove a workspace (hover it, then ×) to add another.
            </span>
          </div>
        ) : mode === "local" ? (
          <LocalAdd onBrowse={() => setBrowsing(true)} onDone={onDone} />
        ) : (
          <CloudAddForm compact onDone={onDone} />
        )}
      </div>
    </div>
  )
}

function LocalAdd({ onBrowse, onDone }: { onBrowse(): void; onDone(): void }) {
  const { add, activeId } = useWorkspaces()
  const [picking, setPicking] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Native OS dialog on the machine syrup runs on. Falls back to the in-app browser.
  async function pickNative() {
    setPicking(true)
    setErr(null)
    try {
      const r = await fetch("/api/workspace/pick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startIn: activeId ?? undefined }) })
      const j = await r.json()
      if (j.path) {
        const e = await add({ path: j.path })
        if (e) setErr(e)
        else onDone()
      } else if (!j.cancelled) {
        setErr(j.error ?? "Could not open a folder dialog")
        onBrowse()
      }
    } catch {
      setErr("Could not open a folder dialog")
      onBrowse()
    } finally {
      setPicking(false)
    }
  }

  return (
    <>
      <button type="button" onClick={() => void pickNative()} disabled={picking} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-surface disabled:opacity-60">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-line-2 text-[15px] text-accent">+</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-ink">{picking ? "Waiting for the folder dialog…" : "Add a folder"}</span>
          <span className="block text-[11px] text-muted">Opens your system&apos;s folder picker</span>
        </span>
      </button>
      <button type="button" onClick={onBrowse} className="w-full rounded-lg px-2 py-1 text-left text-[11px] text-muted transition hover:bg-surface hover:text-ink">
        or type / browse a path
      </button>
      {err && <div className="px-2 pt-1 text-[11px] text-warn">{err}</div>}
    </>
  )
}

function FolderBrowser({ onBack, onChoose }: { onBack(): void; onChoose(path: string): void }) {
  const { activeId } = useWorkspaces()
  const [data, setData] = useState<Browse | null>(null)
  const [typed, setTyped] = useState("")

  useEffect(() => {
    let alive = true
    fetch(`/api/workspace?path=${encodeURIComponent(typed || activeId || "")}`)
      .then((r) => r.json())
      .then((j: Browse) => alive && setData(j))
    return () => {
      alive = false
    }
  }, [typed, activeId])

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-line p-1.5">
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && data?.exists && onChoose(data.path)}
          placeholder={data?.path ?? "Type a path…"}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 font-mono text-[12px] outline-none placeholder:text-muted"
        />
      </div>
      <div className="max-h-[260px] overflow-y-auto py-1">
        {data?.parent && (
          <button type="button" onClick={() => setTyped(data.parent!)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] text-ink-2 hover:bg-surface-2">
            <span className="text-muted">↑</span> ..
          </button>
        )}
        {data && !data.exists && <div className="px-3 py-2 text-[12px] text-err">Folder not found.</div>}
        {data?.dirs.map((d) => (
          <button key={d.path} type="button" onClick={() => setTyped(d.path)} onDoubleClick={() => onChoose(d.path)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink">
            <span className="truncate">{d.name}</span>
            {d.git && <span className="rounded bg-surface-2 px-1 text-[10px] text-muted">git</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line p-1.5">
        <button type="button" onClick={onBack} className="rounded-lg px-2 py-1 text-[12px] text-muted hover:text-ink">
          Back
        </button>
        <button type="button" disabled={!data?.exists} onClick={() => data && onChoose(data.path)} className="rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-40">
          Use {data ? baseName(data.path) : ""}
        </button>
      </div>
    </div>
  )
}

/** Cloud: new workspace from a public repository, or an empty one. */
export function CloudAddForm({ compact, onDone }: { compact?: boolean; onDone?(): void }) {
  const { add } = useWorkspaces()
  const [repo, setRepo] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function create(empty: boolean) {
    setBusy(true)
    setErr(null)
    const e = await add(empty ? { name: "Scratch" } : { repoUrl: repo })
    setBusy(false)
    if (e) setErr(e)
    else {
      setRepo("")
      onDone?.()
    }
  }

  return (
    <div className={compact ? "space-y-1.5 p-0.5" : "space-y-2"}>
      <input
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && repo.trim().length >= 3 && void create(false)}
        placeholder="owner/repo or https://github.com/…"
        className={`w-full rounded-lg border border-line bg-bg px-2.5 font-mono outline-none placeholder:font-sans placeholder:text-muted focus:border-line-2 ${compact ? "py-1.5 text-[12px]" : "py-2 text-[13px]"}`}
      />
      <div className="flex gap-1.5">
        <button type="button" onClick={() => void create(false)} disabled={busy || repo.trim().length < 3} className="flex-1 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-accent-ink disabled:opacity-40">
          {busy ? "Creating…" : "Add from repo"}
        </button>
        <button type="button" onClick={() => void create(true)} disabled={busy} className="rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12px] font-medium text-ink disabled:opacity-40">
          Empty
        </button>
      </div>
      <div className="text-[11px] leading-snug text-muted">Public repos on GitHub, GitLab, Bitbucket or Codeberg.</div>
      {err && <div className="text-[11px] text-err">{err}</div>}
    </div>
  )
}
