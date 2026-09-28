"use client"

import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useEngine } from "@/lib/engine-store"
import { copyText, hostOS, localFileAction, revealLabel } from "@/lib/file-actions"
import { fmtBytes, joinRel, parentRel } from "@/lib/fs-rules"
import { useNav } from "@/lib/nav"
import { PANEL_MIN, PANEL_SHORTCUT, PANEL_WIDE, usePanel, type PanelTab } from "@/lib/panel"
import { useDismiss } from "@/lib/use-dismiss"
import { useLongPress } from "@/lib/use-long-press"
import { useNarrow } from "@/lib/use-window-class"
import { absPath, downloadFile, downloadZip, filesFromDrop, list, upload, type Entry, type Target, type Upload } from "@/lib/workspace-fs"
import { Brew, Skel } from "./brew"
import { ChangesTab, useChangeCount } from "./changes"
import { Menu, type MenuItem } from "./file-link"
import { FilePreview } from "./file-preview"
import { MenuList, Popover, Sheet } from "./ui/sheet"

/**
 * The chat column plus, when open, the workspace panel (Changes · Files ·
 * Preview; docs/RESPONSIVE.md §6). Phones and tablets: a full-screen layer over
 * the chat, which stays mounted underneath (its scroll position survives).
 * 840–1199px: a side pane, the sidebar drops to its rail and the chat keeps
 * 440px. From 1200px: the resizable side pane.
 */
export function Workbench({ children }: { children: ReactNode }) {
  const panel = usePanel()
  const narrow = useNarrow()
  const layer = narrow && !!panel?.open
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div inert={layer || undefined} className="relative flex min-w-0 flex-1 flex-col">
        {children}
      </div>
      {panel?.open && (narrow ? <PanelLayer /> : <SidePane />)}
    </div>
  )
}

/**
 * Opens and closes the panel. Default: "Files" with an icon, for desktop headers. `compact`: icon only
 * (36px, 44px on touch) with the chat's changed-file count as a badge, for phone headers.
 */
export function PanelToggle({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const panel = usePanel()
  const c = useChangeCount(panel?.sessionID)
  if (!panel) return null
  const label = `${panel.open ? "Hide" : "Show"} changes, files & preview`
  if (compact)
    return (
      <button
        type="button"
        // With changed files, opening shows Changes first: what the agent did is what you check on a phone.
        onClick={() => (!panel.open && c.files > 0 ? panel.openTab("changes") : panel.toggle())}
        aria-pressed={panel.open}
        aria-label={c.files > 0 ? `${label} (${c.files} changed file${c.files === 1 ? "" : "s"})` : label}
        title={`${label} (${PANEL_SHORTCUT})`}
        className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition pointer-coarse:h-11 pointer-coarse:w-11 ${panel.open ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"} ${className}`}
      >
        <PanelIcon size={17} />
        {c.files > 0 && (
          <span aria-hidden className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-medium text-accent-ink tabular-nums pointer-coarse:top-1.5 pointer-coarse:right-1.5">
            {c.files > 99 ? "99+" : c.files}
          </span>
        )}
      </button>
    )
  return (
    <button
      type="button"
      onClick={panel.toggle}
      aria-pressed={panel.open}
      title={`${label} (${PANEL_SHORTCUT})`}
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition pointer-coarse:min-h-11 ${panel.open ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"} ${className}`}
    >
      <PanelIcon />
      Files
    </button>
  )
}

const TAB_LABEL: Record<PanelTab, string> = { changes: "Changes", files: "Files", preview: "Preview" }
const TABS: PanelTab[] = ["changes", "files", "preview"]

/** Desktop: a pane right of the chat, resizable from its left edge. */
function SidePane() {
  const panel = usePanel()!
  const setRail = useNav()?.setRailForced
  const count = useChangeCount(panel.sessionID)
  const ref = useRef<HTMLElement>(null)
  const [live, setLive] = useState<number | null>(null)
  const drag = useRef<{ x: number; w: number } | null>(null)
  const width = live ?? panel.width

  // 840–1199px: the sidebar steps down to its rail while the pane is open.
  useEffect(() => {
    setRail?.(true)
    return () => setRail?.(false)
  }, [setRail])

  // Large: 320–1100px (and 70% of the window), as always. Expanded: whatever leaves the chat 440px.
  const max = () => {
    const large = window.matchMedia("(min-width: 75rem)").matches
    const room = ref.current?.parentElement?.clientWidth ?? window.innerWidth
    return Math.max(PANEL_MIN, Math.min(large ? 1100 : room - 440, window.innerWidth * 0.7))
  }

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
    <aside ref={ref} style={{ width }} aria-label="Workspace panel" className="relative flex max-w-[75vw] shrink-0 flex-col border-l border-line bg-surface/50 max-large:max-w-[calc(100%-440px)]">
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize · double-click to switch width"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => panel.setWidth(panel.width >= PANEL_WIDE - 40 ? 440 : Math.min(PANEL_WIDE, max()))}
        className={`absolute inset-y-0 -left-[3px] z-10 w-[6px] cursor-col-resize touch-none transition-colors hover:bg-accent/30 pointer-coarse:-left-2 pointer-coarse:w-4 ${live !== null ? "bg-accent/40" : ""}`}
      />
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        {TABS.map((t) => (
          <Tab key={t} active={panel.tab === t} onClick={() => panel.setTab(t)}>
            {t === "preview" ? (
              <span className="max-w-[180px] truncate">{panel.selected ? `Preview · ${panel.selected.split("/").pop()}` : "Preview"}</span>
            ) : (
              TAB_LABEL[t]
            )}
            {t === "changes" && count.files > 0 && <span className="ml-1.5 text-[11px] text-muted tabular-nums">{count.files}</span>}
          </Tab>
        ))}
        <div className="flex-1" />
        <button type="button" onClick={() => panel.setOpen(false)} title={`Close (${PANEL_SHORTCUT})`} aria-label="Close panel" className="flex items-center justify-center rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11">
          <CloseIcon size={12} />
        </button>
      </header>
      <PanelBody />
    </aside>
  )
}

/** Phones and tablets: the panel covers the chat. ✕ (or back) returns to it. */
function PanelLayer() {
  const panel = usePanel()!
  const count = useChangeCount(panel.sessionID)
  const [menu, setMenu] = useState(false)
  const closeBtn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeBtn.current?.focus({ preventScroll: true })
  }, [])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && !e.defaultPrevented) panel.setOpen(false)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Workspace panel" onKeyDown={onKeyDown} className="fixed inset-0 z-40 flex flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-1">
        <button ref={closeBtn} type="button" onClick={() => panel.setOpen(false)} aria-label="Close panel" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink">
          <CloseIcon size={14} />
        </button>
        <div role="tablist" aria-label="Panel" className="flex min-w-0 flex-1 justify-center gap-0.5">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={panel.tab === t}
              onClick={() => panel.setTab(t)}
              className={`flex h-9 min-w-0 items-center rounded-lg px-3 text-[14px] transition pointer-coarse:h-11 ${panel.tab === t ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:text-ink"}`}
            >
              <span className="truncate">{TAB_LABEL[t]}</span>
              {t === "changes" && count.files > 0 && <span className="ml-1 text-[12px] font-normal text-muted tabular-nums">{count.files}</span>}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setMenu(true)} aria-label="View options" aria-haspopup="menu" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink">
          <MoreIcon />
        </button>
        <Sheet open={menu} onClose={() => setMenu(false)} title="View">
          <MenuList
            onDone={() => setMenu(false)}
            items={[
              { label: "Wrap long lines in diffs", hint: panel.wrap ? "On" : "Off", onSelect: () => panel.setWrap(!panel.wrap) },
              { label: "Show hidden folders", hint: panel.showHidden ? "On" : "Off", onSelect: () => panel.setShowHidden(!panel.showHidden) },
            ]}
          />
        </Sheet>
      </header>
      <PanelBody />
    </div>
  )
}

/** The three tabs' content. All stay mounted, so switching keeps each tab's scroll and state. */
function PanelBody() {
  const panel = usePanel()!
  const show = (t: PanelTab) => `min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${panel.tab === t ? "flex" : "hidden"}`
  const waking = (
    <div className="p-4">
      <Brew mood="wake" timerAfter={10} />
    </div>
  )
  return (
    <>
      <div className={show("changes")}>
        <ChangesTab />
      </div>
      <div className={show("files")}>{panel.target ? <FileTree key={`${panel.target.dir}|${panel.target.conn?.baseUrl ?? ""}|${panel.showHidden}`} target={panel.target} /> : waking}</div>
      <div className={show("preview")}>
        {!panel.selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">Pick a file in Files and it shows up here.</div>
        ) : panel.target ? (
          <FilePreview key={`${panel.target.dir}|${panel.selected}`} target={panel.target} rel={panel.selected} />
        ) : (
          waking
        )}
      </div>
    </>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`flex min-w-0 items-center rounded-lg px-2.5 py-1 text-xs transition pointer-coarse:min-h-11 ${active ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>
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
  const [more, setMore] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const closeMore = useCallback(() => setMore(false), [])
  useDismiss(moreRef, more, closeMore)
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
          <button type="button" onClick={() => void load(rel)} className="text-accent underline underline-offset-2 pointer-coarse:py-2">
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
          <Row
            entry={e}
            depth={depth}
            open={open}
            active={selected === e.rel}
            dropping={dir && drop === e.rel}
            onOpen={() => (dir ? panel.toggleFolder(e.rel) : panel.openFile(e.rel))}
            onMenu={(ev) => openMenu(ev, e)}
            onMenuAt={(x, y) => setMenu({ x, y, entry: e })}
          />
          {open && rows(e.rel, depth + 1)}
        </div>
      )
    })
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5 pointer-coarse:py-0.5">
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
        <IconButton label="Refresh" onClick={refresh}>
          <path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 2.5v2.8H8.7" />
        </IconButton>
        <div ref={moreRef} className="relative">
          <IconButton label="More" pressed={more} onClick={() => setMore((v) => !v)}>
            <circle cx="3" cy="7" r=".9" fill="currentColor" stroke="none" />
            <circle cx="7" cy="7" r=".9" fill="currentColor" stroke="none" />
            <circle cx="11" cy="7" r=".9" fill="currentColor" stroke="none" />
          </IconButton>
          <Popover open={more} onClose={closeMore} title={rootName} className="absolute top-full right-0 z-20 mt-1 w-[260px] rounded-xl border border-line bg-surface shadow-card">
            <MenuList
              onDone={closeMore}
              items={[
                { label: showHidden ? "Hide .git, node_modules and caches" : "Show hidden folders", hint: showHidden ? "On" : undefined, onSelect: () => panel.setShowHidden(!showHidden) },
                { label: `Download ${rootName} as .zip`, onSelect: () => void zip("") },
              ]}
            />
          </Popover>
        </div>
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
        className={`min-h-0 flex-1 overflow-auto overscroll-contain py-1 transition ${drop === "" ? "bg-accent-soft/40 outline-2 -outline-offset-4 outline-accent/50 outline-dashed" : ""}`}
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

/** Tap opens; right-click, a long press or the ⋯ (always there on touch, on hover with a mouse) gives the actions. */
function Row({
  entry,
  depth,
  open,
  active,
  dropping,
  onOpen,
  onMenu,
  onMenuAt,
}: {
  entry: Entry
  depth: number
  open: boolean
  active: boolean
  dropping: boolean
  onOpen(): void
  onMenu(e: ReactMouseEvent): void
  onMenuAt(x: number, y: number): void
}) {
  const dir = entry.type === "directory"
  const press = useLongPress<HTMLButtonElement>((x, y) => onMenuAt(x, y))
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
        {...press}
        onClick={onOpen}
        onContextMenu={onMenu}
        title={entry.rel}
        style={{ paddingLeft: 6 + depth * 14 }}
        className={`flex min-w-0 flex-1 items-center gap-1.5 py-[3px] text-left text-[13px] outline-none [-webkit-touch-callout:none] focus-visible:underline pointer-coarse:min-h-11 pointer-coarse:text-[14px] pointer-coarse:select-none ${entry.ignored ? "text-muted" : "text-ink-2"} ${active ? "text-ink" : ""}`}
      >
        <span className="flex w-3 shrink-0 justify-center text-muted">
          {dir && (
            <svg width="8" height="8" viewBox="0 0 8 8" className={`transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}>
              <path d="M2.5 1.2 5.6 4 2.5 6.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        {dir ? <FolderIcon open={open} /> : <FileIcon />}
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>
      <button
        type="button"
        onClick={onMenu}
        aria-label={`Actions for ${entry.name}`}
        className="mr-1 flex shrink-0 items-center justify-center rounded px-1 text-muted transition hover:text-ink focus-visible:opacity-100 pointer-coarse:mr-0 pointer-coarse:h-11 pointer-coarse:w-11 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
      >
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
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`flex items-center justify-center rounded-lg p-1.5 transition pointer-coarse:h-11 pointer-coarse:w-11 ${pressed ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"}`}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}

function PanelIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.5" y="2" width="11" height="10" rx="2" />
      <path d="M8.5 2v10" />
    </svg>
  )
}

function CloseIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
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
