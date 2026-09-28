"use client"

import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useEngine } from "@/lib/engine-store"
import { copyText, hostOS, localFileAction, revealLabel } from "@/lib/file-actions"
import { fmtBytes, joinRel, parentRel } from "@/lib/fs-rules"
import { PANEL_MIN, PANEL_SHORTCUT, PANEL_WIDE, usePanel } from "@/lib/panel"
import { absPath, downloadFile, downloadZip, filesFromDrop, list, upload, type Entry, type Target, type Upload } from "@/lib/workspace-fs"
import { Brew, Skel } from "./brew"
import { Menu, type MenuItem } from "./file-link"
import { FilePreview } from "./file-preview"

/** The chat column plus, when open, the Files + Preview panel on its right. */
export function Workbench({ children }: { children: ReactNode }) {
  const panel = usePanel()
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">{children}</div>
      {panel?.open && <SidePanel />}
    </div>
  )
}

export function PanelToggle({ className = "" }: { className?: string }) {
  const panel = usePanel()
  if (!panel) return null
  return (
    <button
      type="button"
      onClick={panel.toggle}
      aria-pressed={panel.open}
      title={`${panel.open ? "Hide" : "Show"} files & preview (${PANEL_SHORTCUT})`}
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition ${panel.open ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"} ${className}`}
    >
      <PanelIcon />
      Files
    </button>
  )
}

function SidePanel() {
  const panel = usePanel()!
  const [live, setLive] = useState<number | null>(null)
  const drag = useRef<{ x: number; w: number } | null>(null)
  const width = live ?? panel.width
  const max = () => Math.max(PANEL_MIN, Math.min(1100, window.innerWidth * 0.7))

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: width }
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    setLive(Math.max(PANEL_MIN, Math.min(max(), drag.current.w + drag.current.x - e.clientX)))
  }
  function onPointerUp() {
    if (!drag.current) return
    drag.current = null
    if (live !== null) panel.setWidth(live)
    setLive(null)
  }

  return (
    <aside style={{ width }} aria-label="Files and preview" className="relative flex max-w-[75vw] shrink-0 flex-col border-l border-line bg-surface/50">
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize · double-click to switch width"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => panel.setWidth(panel.width >= PANEL_WIDE - 40 ? 440 : Math.min(PANEL_WIDE, max()))}
        className={`absolute inset-y-0 -left-[3px] z-10 w-[6px] cursor-col-resize transition-colors hover:bg-accent/30 ${live !== null ? "bg-accent/40" : ""}`}
      />
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        <Tab active={panel.tab === "files"} onClick={() => panel.setTab("files")}>
          Files
        </Tab>
        <Tab active={panel.tab === "preview"} onClick={() => panel.setTab("preview")}>
          <span className="max-w-[180px] truncate">{panel.selected ? `Preview · ${panel.selected.split("/").pop()}` : "Preview"}</span>
        </Tab>
        <div className="flex-1" />
        <button type="button" onClick={() => panel.setOpen(false)} title={`Close (${PANEL_SHORTCUT})`} aria-label="Close panel" className="rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </header>
      <div className={`min-h-0 flex-1 flex-col ${panel.tab === "files" ? "flex" : "hidden"}`}>
        {panel.target ? (
          <FileTree key={`${panel.target.dir}|${panel.target.conn?.baseUrl ?? ""}|${panel.showHidden}`} target={panel.target} />
        ) : (
          <div className="p-4">
            <Brew mood="wake" timerAfter={10} />
          </div>
        )}
      </div>
      <div className={`min-h-0 flex-1 flex-col ${panel.tab === "preview" ? "flex" : "hidden"}`}>
        {!panel.selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">Pick a file in Files and it shows up here.</div>
        ) : panel.target ? (
          <FilePreview key={`${panel.target.dir}|${panel.selected}`} target={panel.target} rel={panel.selected} />
        ) : (
          <div className="p-4">
            <Brew mood="wake" timerAfter={10} />
          </div>
        )}
      </div>
    </aside>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`flex min-w-0 items-center rounded-lg px-2.5 py-1 text-xs transition ${active ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>
      {children}
    </button>
  )
}

type Dir = Entry[] | { error: string }
type Status = { text: string; tone?: "warn" | "ok"; busy?: boolean; at: number }

const REFRESH_DEBOUNCE_MS = 700
const POLL_MS = 15_000

function FileTree({ target }: { target: Target }) {
  const panel = usePanel()!
  const { onFilesChanged } = useEngine()
  const { expanded, showHidden, selected } = panel
  const [dirs, setDirs] = useState<Record<string, Dir>>({})
  const [status, setStatus] = useState<Status | null>(null)
  const [drop, setDrop] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null } | null>(null)
  const inflight = useRef(new Set<string>())
  const expandedRef = useRef(expanded)
  const picker = useRef<HTMLInputElement>(null)
  const pickFor = useRef("")
  const cloud = !!target.workspaceId
  const rootName = target.dir.split(/[\\/]/).filter(Boolean).pop() || target.dir

  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  const load = useCallback(
    async (rel: string) => {
      if (inflight.current.has(rel)) return
      inflight.current.add(rel)
      try {
        const entries = await list(target, rel, showHidden)
        setDirs((d) => ({ ...d, [rel]: entries }))
      } catch (err) {
        setDirs((d) => ({ ...d, [rel]: { error: err instanceof Error ? err.message : String(err) } }))
      } finally {
        inflight.current.delete(rel)
      }
    },
    [target, showHidden],
  )

  useEffect(() => {
    for (const rel of expanded) if (!(rel in dirs)) void load(rel)
  }, [expanded, dirs, load])

  const refresh = useCallback(() => {
    for (const rel of expandedRef.current) void load(rel)
  }, [load])

  // The agent edits files: refresh what's expanded, a moment after the burst settles. A slow poll catches the rest.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const off = onFilesChanged(() => {
      clearTimeout(t)
      t = setTimeout(refresh, REFRESH_DEBOUNCE_MS)
    })
    const poll = setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS)
    return () => {
      off()
      clearTimeout(t)
      clearInterval(poll)
    }
  }, [onFilesChanged, refresh])

  const say = useCallback((text: string, tone?: Status["tone"], busy?: boolean) => setStatus({ text, tone, busy, at: Date.now() }), [])
  useEffect(() => {
    if (!status || status.busy) return
    const t = setTimeout(() => setStatus(null), status.tone === "warn" ? 6000 : 3500)
    return () => clearTimeout(t)
  }, [status])

  async function zip(rel: string) {
    const label = rel ? rel.split("/").pop() : rootName
    say(`Zipping ${label}`, undefined, true)
    try {
      const n = await downloadZip(target, rel, showHidden)
      say(`Downloaded ${label}.zip · ${n} file${n === 1 ? "" : "s"}`, "ok")
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), "warn")
    }
  }

  async function save(e: Entry) {
    say(`Fetching ${e.name}`, undefined, true)
    try {
      await downloadFile(target, e.rel, e.name)
      say(`Downloaded ${e.name}`, "ok")
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), "warn")
    }
  }

  async function send(items: Upload[], dir: string) {
    if (!items.length) return
    const where = dir ? `${dir}/` : rootName
    const total = items.reduce((n, i) => n + i.file.size, 0)
    say(`Uploading ${items.length} file${items.length === 1 ? "" : "s"} to ${where}`, undefined, true)
    try {
      await upload(target, items, (done) => total > 2 * 1024 * 1024 && say(`Uploading to ${where} · ${Math.round((done / total) * 100)}%`, undefined, true))
      say(`Uploaded ${items.length} file${items.length === 1 ? "" : "s"} to ${where} · ${fmtBytes(total)}`, "ok")
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), "warn")
    }
    if (dir && !expandedRef.current.has(dir)) panel.toggleFolder(dir)
    refresh()
    void load(dir)
  }

  async function reveal(rel: string) {
    const err = await localFileAction(target.dir, absPath(target, rel), "reveal")
    if (err) say(err === "missing" ? "It isn't there anymore" : err, "warn")
  }

  async function copy(text: string, what: string) {
    await copyText(text)
    say(`Copied ${what}`)
  }

  function menuItems(e: Entry | null): MenuItem[] {
    const rel = e?.rel ?? ""
    const items: MenuItem[] = []
    if (e?.type === "file") items.push({ label: "Preview", run: () => panel.openFile(rel) }, { label: "Download", run: () => void save(e) })
    else {
      items.push({ label: "Download as .zip", run: () => void zip(rel) })
      items.push({
        label: "Upload files here…",
        run: () => {
          pickFor.current = rel
          picker.current?.click()
        },
      })
    }
    if (!cloud) items.push({ label: revealLabel(hostOS()), run: () => void reveal(rel) })
    items.push("sep", { label: "Copy path", run: () => void copy(absPath(target, rel), "path") })
    if (rel) items.push({ label: "Copy relative path", run: () => void copy(rel, "relative path") })
    return items
  }

  function openMenu(ev: ReactMouseEvent, entry: Entry | null) {
    ev.preventDefault()
    ev.stopPropagation()
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: ev.clientX || r.left, y: ev.clientY || r.bottom + 4, entry })
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    setDrop((e.target as HTMLElement).closest("[data-drop]")?.getAttribute("data-drop") ?? "")
  }

  function onDrop(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    const dir = drop ?? ""
    setDrop(null)
    // Entries must be taken from the DataTransfer before the first await.
    void filesFromDrop(e.dataTransfer, dir).then((items) => send(items, dir))
  }

  function rows(rel: string, depth: number): ReactNode {
    const d = dirs[rel]
    if (!d) return <TreeSkeleton depth={depth} />
    if (!Array.isArray(d))
      return (
        <div style={{ paddingLeft: 12 + depth * 14 }} className="py-1 pr-2 text-[12px] text-warn">
          {d.error}{" "}
          <button type="button" onClick={() => void load(rel)} className="text-accent underline underline-offset-2">
            Retry
          </button>
        </div>
      )
    if (d.length === 0) return <div style={{ paddingLeft: 12 + depth * 14 + 18 }} className="py-1 text-[12px] text-muted">{rel ? "Empty folder" : "Nothing here yet. Drop files to add them."}</div>
    return d.map((e) => {
      const dir = e.type === "directory"
      const open = dir && expanded.has(e.rel)
      return (
        <div key={e.rel}>
          <Row entry={e} depth={depth} open={open} active={selected === e.rel} dropping={dir && drop === e.rel} onOpen={() => (dir ? panel.toggleFolder(e.rel) : panel.openFile(e.rel))} onMenu={(ev) => openMenu(ev, e)} />
          {open && rows(e.rel, depth + 1)}
        </div>
      )
    })
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-[11px] text-muted" title={target.dir}>
          {rootName}
        </span>
        <IconButton
          label="Upload files"
          onClick={() => {
            pickFor.current = ""
            picker.current?.click()
          }}
        >
          <path d="M7 10V2.5M3.8 5.5 7 2.3l3.2 3.2M2.5 11.5h9" />
        </IconButton>
        <IconButton label={`Download ${rootName} as .zip`} onClick={() => void zip("")}>
          <path d="M7 2.5V10M3.8 7 7 10.2 10.2 7M2.5 11.5h9" />
        </IconButton>
        <IconButton label={showHidden ? "Hide .git, node_modules and caches" : "Show hidden folders"} pressed={showHidden} onClick={() => panel.setShowHidden(!showHidden)}>
          <path d="M1.5 7s2-3.8 5.5-3.8S12.5 7 12.5 7 10.5 10.8 7 10.8 1.5 7 1.5 7Z" />
          <circle cx="7" cy="7" r="1.6" />
          {!showHidden && <path d="M2.5 11.5l9-9" />}
        </IconButton>
        <IconButton label="Refresh" onClick={refresh}>
          <path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 2.5v2.8H8.7" />
        </IconButton>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ""
            void send(
              files.map((file) => ({ file, rel: joinRel(pickFor.current, file.name) })),
              pickFor.current,
            )
          }}
        />
      </div>
      <div
        role="tree"
        aria-label={`Files in ${rootName}`}
        data-drop=""
        onDragOver={onDragOver}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}
        onDrop={onDrop}
        onContextMenu={(e) => openMenu(e, null)}
        className={`min-h-0 flex-1 overflow-auto py-1 transition ${drop === "" ? "bg-accent-soft/40 outline-2 -outline-offset-4 outline-accent/50 outline-dashed" : ""}`}
      >
        {rows("", 0)}
      </div>
      {status && (
        <div role="status" className={`flex shrink-0 items-center gap-2 border-t border-line px-3 py-2 text-[12px] ${status.tone === "warn" ? "text-warn" : status.tone === "ok" ? "text-ink-2" : "text-muted"}`}>
          {status.busy ? <Brew label={status.text} timerAfter={3} /> : <span className="min-w-0 truncate">{status.text}</span>}
        </div>
      )}
      {menu &&
        createPortal(
          <Menu at={{ x: menu.x, y: menu.y }} title={menu.entry?.rel || rootName} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />,
          document.body,
        )}
    </>
  )
}

function Row({ entry, depth, open, active, dropping, onOpen, onMenu }: { entry: Entry; depth: number; open: boolean; active: boolean; dropping: boolean; onOpen(): void; onMenu(e: ReactMouseEvent): void }) {
  const dir = entry.type === "directory"
  return (
    <div
      data-drop={dir ? entry.rel : parentRel(entry.rel)}
      className={`group flex items-center rounded-md transition ${active ? "bg-surface-2" : "hover:bg-surface-2/70"} ${dropping ? "bg-accent-soft/60 outline-1 -outline-offset-1 outline-accent/60 outline-dashed" : ""} mx-1`}
    >
      <button
        type="button"
        role="treeitem"
        aria-expanded={dir ? open : undefined}
        aria-selected={active}
        onClick={onOpen}
        onContextMenu={onMenu}
        title={entry.rel}
        style={{ paddingLeft: 6 + depth * 14 }}
        className={`flex min-w-0 flex-1 items-center gap-1.5 py-[3px] text-left text-[13px] outline-none focus-visible:underline ${entry.ignored ? "text-muted" : "text-ink-2"} ${active ? "text-ink" : ""}`}
      >
        <span className="flex w-3 shrink-0 justify-center text-muted">
          {dir && (
            <svg width="8" height="8" viewBox="0 0 8 8" className={`transition-transform ${open ? "rotate-90" : ""}`}>
              <path d="M2.5 1.2 5.6 4 2.5 6.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        {dir ? <FolderIcon open={open} /> : <FileIcon />}
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>
      <button type="button" onClick={onMenu} aria-label={`Actions for ${entry.name}`} className="mr-1 shrink-0 rounded px-1 text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink focus-visible:opacity-100">
        ⋯
      </button>
    </div>
  )
}

function TreeSkeleton({ depth }: { depth: number }) {
  return (
    <div aria-busy className="skel-in space-y-2 py-1.5" style={{ paddingLeft: 26 + depth * 14 }}>
      {[62, 48, 70, 40].map((w, i) => (
        <Skel key={i} className="h-3" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

function IconButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-pressed={pressed} className={`rounded-lg p-1.5 transition ${pressed ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}

function PanelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.5" y="2" width="11" height="10" rx="2" />
      <path d="M8.5 2v10" />
    </svg>
  )
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 text-accent/80" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      {open ? <path d="M1.8 11.2V3.4c0-.4.3-.7.7-.7h2.8l1.2 1.3h4.3c.4 0 .7.3.7.7v1.2M1.8 11.2l1.6-4.6c.1-.3.4-.5.7-.5h7.9c.4 0 .7.4.6.8l-1.3 4.3H1.8Z" /> : <path d="M1.8 11.2V3.4c0-.4.3-.7.7-.7h2.8l1.2 1.3h4.9c.4 0 .7.3.7.7v5.8c0 .4-.3.7-.7.7H2.5c-.4 0-.7-.3-.7-.7Z" />}
    </svg>
  )
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M3.2 1.8h4.6l3 3v7c0 .4-.3.7-.7.7H3.2c-.4 0-.7-.3-.7-.7V2.5c0-.4.3-.7.7-.7Z M7.6 1.9v3h3" />
    </svg>
  )
}
