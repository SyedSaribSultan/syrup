"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { hostOS, localFileAction } from "@/lib/file-actions"
import { Skel } from "./brew"
import { confirmDialog } from "./ui/dialog"
import { Button, Icon, IconButton } from "./ui/s"
import { Popover } from "./ui/sheet"
import { useDismiss } from "@/lib/use-dismiss"
import { useOverlay } from "@/lib/use-presence"
import { MAX_WORKSPACES } from "@/lib/workspace-limits"
import { baseName, useAllChats, useWorkspaces, wsColor, type WorkspaceItem } from "@/lib/workspaces"

type Browse = { path: string; exists: boolean; git?: boolean; parent: string | null; dirs: { name: string; path: string; git: boolean }[]; home?: string }

/** The workspace's colour key: an 8px dot on chat rows and in the switcher. Data colours (--ws-*), never brand red. */
export function WorkspaceDot({ color, className = "" }: { color: number; className?: string }) {
  return <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${className}`} style={{ background: wsColor(color) }} />
}

/** Last two path segments, e.g. …\repos\syrup. Repo and cloud details pass through. */
function shortDetail(detail: string): string {
  const sep = detail.includes("\\") ? "\\" : "/"
  const parts = detail.split(/[\\/]/).filter(Boolean)
  return /^[a-z]:|^\//i.test(detail) && parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : detail
}

/**
 * The context switcher: a B9 lg row (sarib-design DESIGN.md §11.2: avatar, name, path, chevron) that opens a raised
 * menu of workspaces. `controls`: the open workspace's own settings (cloud: network access, stop), under the list.
 */
export function WorkspaceSwitcher({ controls }: { controls?: ReactNode }) {
  const { workspaces, activeId } = useWorkspaces()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = workspaces?.find((w) => w.id === activeId) ?? null

  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" title={active?.detail} className="s-row s-row--lg pointer-coarse:min-h-14">
        <span className="s-avatar s-avatar--md">{active ? active.name.slice(0, 1).toUpperCase() : <Icon name="folder" />}</span>
        <span className="s-row__text">
          <span className="s-row__title">{active ? active.name : workspaces ? "Choose a workspace" : <Skel className="h-3 w-20" />}</span>
          <span className="s-row__sub">{active ? shortDetail(active.detail) : "No workspace open"}</span>
        </span>
        <Icon name="chevron-down" className="s-row__chevron" />
      </button>

      <Popover open={open} onClose={close} label="Workspaces" side="down" className="s-raised s-raised--md absolute top-full left-0 z-dropdown mt-2 w-[328px] overflow-hidden">
        <Menu onDone={close} />
        {controls && (
          <div className="border-t border-line p-1">
            <p className="s-menu__label">This workspace</p>
            {controls}
          </div>
        )}
      </Popover>
    </div>
  )
}

function Menu({ onDone }: { onDone(): void }) {
  const { mode, workspaces, activeId, full, open, remove, add } = useWorkspaces()
  // Opening a workspace navigates (cloud) or swaps the whole screen (local): the menu closes without its exit (MOTION.md §4.3).
  const overlay = useOverlay()
  const chats = useAllChats()
  const [browsing, setBrowsing] = useState(false)
  const counts = new Map<string, number>()
  for (const c of chats) counts.set(c.workspaceId, (counts.get(c.workspaceId) ?? 0) + 1)

  async function onRemove(w: WorkspaceItem) {
    const ok = await confirmDialog(
      mode === "cloud"
        ? { title: `Delete "${w.name}"?`, body: "This destroys its sandbox and every file in it. It cannot be undone. Its chats leave the list (the history stays in your account).", confirmLabel: "Delete", danger: true }
        : w.missing
          ? { title: `Remove "${w.name}" from syrup?`, body: `${w.detail} is not on disk any more. Its chats come back if you add the folder again.`, confirmLabel: "Remove" }
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

  if (browsing)
    return (
      <FolderBrowser
        onBack={() => setBrowsing(false)}
        onChoose={(path) =>
          void add({ path }).then((err) => {
            if (err) return
            overlay?.skipExit()
            onDone()
          })
        }
      />
    )

  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
        <span className="text-sm text-ink">Switch workspace</span>
        <span className={`s-count ${full ? "text-warn" : ""}`} title={`Up to ${MAX_WORKSPACES} workspaces, one colour each`}>
          {workspaces?.length ?? 0} of {MAX_WORKSPACES}
        </span>
      </div>
      <div className="flex max-h-[360px] flex-col overflow-y-auto p-1 max-expanded:max-h-none">
        {workspaces?.length === 0 && <p className="s-empty-line px-3 py-2">No workspaces yet. Add a folder below.</p>}
        {workspaces?.map((w) => {
          const isActive = w.id === activeId
          const n = counts.get(w.id) ?? 0
          const actions = mode === "local" || (!isActive && !w.home)
          return (
            <div key={w.id} className="group relative">
              <button
                type="button"
                aria-current={isActive || undefined}
                onClick={() => {
                  overlay?.skipExit()
                  open(w.id)
                  onDone()
                }}
                title={w.detail}
                // Two-line rows with an avatar are taller than a one-line item, as their content needs; touch keeps 48.
                className="s-menu__item gap-3 py-2 max-expanded:min-h-12"
              >
                <span className="s-avatar s-avatar--sm">{w.name.slice(0, 1).toUpperCase()}</span>
                <span className="s-menu__text">
                  <span className="flex items-center gap-2">
                    <WorkspaceDot color={w.color} />
                    <span className={`truncate ${w.missing ? "text-ink-2 line-through" : ""}`}>{w.name}</span>
                    {w.missing && <span className="s-badge s-badge--warning shrink-0">Folder not found</span>}
                  </span>
                  <span className="s-menu__desc truncate">{shortDetail(w.detail)}</span>
                </span>
                {isActive ? (
                  <Icon name="check" size={16} className="text-ink" />
                ) : (
                  <span className={`s-menu__shortcut ${actions ? "motion-fade group-focus-within:opacity-0 group-hover:opacity-0 pointer-coarse:invisible" : ""}`}>
                    {n} {n === 1 ? "chat" : "chats"}
                  </span>
                )}
              </button>
              {actions && (
                <div className={`absolute top-1/2 flex -translate-y-1/2 items-center motion-reveal ${isActive ? "right-8" : "right-1"}`}>
                  {mode === "local" && <IconButton icon="folder-open" label="Open folder" title={`Open folder in ${folderApp}`} onClick={() => void onReveal(w)} />}
                  {!isActive && !w.home && <IconButton icon="close" label={mode === "cloud" ? "Delete workspace" : "Remove from list"} onClick={() => void onRemove(w)} />}
                </div>
              )}
            </div>
          )
        })}
        {folderErr && <p className="s-error-line px-3 py-1">{folderErr}</p>}
      </div>
      <div className="border-t border-line p-1">
        {full ? (
          <div className="s-alert s-alert--warning m-1">
            <Icon name="triangle-alert" />
            <div className="s-alert__body">
              <p className="s-alert__title">All {MAX_WORKSPACES} slots in use</p>
              <p className="s-alert__desc">Remove a workspace (the close button next to it) to add another.</p>
            </div>
          </div>
        ) : mode === "local" ? (
          <LocalAdd onBrowse={() => setBrowsing(true)} onDone={onDone} />
        ) : (
          <div className="p-3">
            <CloudAddForm compact onDone={onDone} />
          </div>
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
    <div className="flex flex-col">
      <button type="button" onClick={() => void pickNative()} disabled={picking} className="s-menu__item gap-3 py-2 max-expanded:min-h-12">
        <span className="s-avatar s-avatar--sm">
          <Icon name="plus" />
        </span>
        <span className="s-menu__text">
          <span className="block">{picking ? "Waiting for the folder dialog…" : "Add a folder"}</span>
          <span className="s-menu__desc">Opens your system&apos;s folder picker</span>
        </span>
      </button>
      <Button variant="link-neutral" size="sm" onClick={onBrowse} className="mx-3 my-2 self-start">
        Or type or browse a path
      </Button>
      {err && <p className="s-error-line px-3 pb-2">{err}</p>}
    </div>
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
    <div className="flex flex-col">
      <div className="border-b border-line p-3">
        <div className="s-field s-field--sm">
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && data?.exists && onChoose(data.path)}
            placeholder={data?.path ?? "Type a path"}
            aria-label="Folder path"
            className="s-field__input"
          />
        </div>
      </div>
      <div className="flex max-h-[260px] flex-col overflow-y-auto p-1">
        {data?.parent && (
          <button type="button" onClick={() => setTyped(data.parent!)} className="s-menu__item gap-2">
            <Icon name="arrow-up" />
            <span className="s-menu__text">Up one folder</span>
          </button>
        )}
        {data && !data.exists && <p className="s-error-line px-3 py-2">Folder not found. Check the path.</p>}
        {data?.dirs.map((d) => (
          <button key={d.path} type="button" onClick={() => setTyped(d.path)} onDoubleClick={() => onChoose(d.path)} className="s-menu__item gap-2">
            <Icon name="folder" />
            <span className="s-menu__text truncate">{d.name}</span>
            {d.git && <span className="s-badge">git</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line p-2">
        <Button variant="secondary" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button size="sm" disabled={!data?.exists} onClick={() => data && onChoose(data.path)} className="min-w-0">
          Use {data ? baseName(data.path) : ""}
        </Button>
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
    <div className="s-form-item flex flex-col gap-3">
      <div className={`s-field ${compact ? "s-field--sm" : ""}`}>
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && repo.trim().length >= 3 && void create(false)}
          placeholder="owner/repo or https://github.com/…"
          aria-label="Repository"
          aria-invalid={err ? true : undefined}
          className="s-field__input"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" busy={busy} disabled={repo.trim().length < 3} onClick={() => void create(false)} className="flex-1">
          {busy ? "Creating…" : "Add from repo"}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void create(true)}>
          Empty
        </Button>
      </div>
      <p className="s-help">Public repos on GitHub, GitLab, Bitbucket or Codeberg.</p>
      {err && <p className="s-field-error">{err}</p>}
    </div>
  )
}
