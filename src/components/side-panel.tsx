"use client"

import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { useNav } from "@/lib/nav"
import { PANEL_MIN, PANEL_SHORTCUT, PANEL_WIDE, usePanel, type PanelTab } from "@/lib/panel"
import { KINDS } from "@/lib/rich/kinds"
import { useLazy } from "@/lib/rich/lazy"
import { useNarrow } from "@/lib/use-window-class"
import { Brew } from "./brew"
import { ChangesTab, useChangeCount } from "./changes"
import { MenuList, Sheet } from "./ui/sheet"

/**
 * A panel tab's body from its own chunk (docs/RENDERING.md decision 4): the panel's usual loader until it arrives,
 * and if it can't (offline, or a tab left open across a deploy that renamed its chunks) a line with Retry and Reload
 * instead of an error that would take the whole app down.
 */
function lazyPanel<M, P extends object>(load: () => Promise<M>, pick: (m: M) => ComponentType<P>, what: string) {
  return function LazyPanel(props: P) {
    const m = useLazy(load)
    if (m.module) {
      const C = pick(m.module)
      return <C {...props} />
    }
    if (m.failed)
      return (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-ink-2">
          <span>Couldn&apos;t load {what}.</span>
          <span className="flex gap-3">
            <button type="button" onClick={m.retry} className="text-accent underline underline-offset-2 pointer-coarse:min-h-11">
              Retry
            </button>
            <button type="button" onClick={() => location.reload()} className="text-accent underline underline-offset-2 pointer-coarse:min-h-11">
              Reload
            </button>
          </span>
        </div>
      )
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Brew mood="load" size="md" />
      </div>
    )
  }
}

function wantsPrefetch(): boolean {
  try {
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false
    return localStorage.getItem("syrup.prefetch") !== "off"
  } catch {
    return true
  }
}

/** The Preview tab's file viewer (and its highlighter and HTML inliner): loaded on idle once the workbench is up. */
const loadFilePreview = () => import("./file-preview")
const FilePreview = lazyPanel(loadFilePreview, (m) => m.FilePreview, "the file preview")
/** The Files tab's tree: loaded on idle too, and when the panel first shows Files. */
const loadFileTree = () => import("./file-tree")
const FileTree = lazyPanel(loadFileTree, (m) => m.FileTree, "the file list")
/** A chat block at full size (Round 2a): loaded when a block is first opened. */
const BlockPreview = lazyPanel(() => import("./rich/block-preview"), (m) => m.BlockPreview, "the diagram viewer")

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
  // Warm the Files and Preview chunks once the chat is idle, so opening the panel or a file doesn't wait for them.
  // Not on a data saver, nor with "syrup.prefetch" set to "off" (the UI harness, to test a chunk that fails to load).
  useEffect(() => {
    if (!wantsPrefetch()) return
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => void Promise.all([loadFilePreview(), loadFileTree()]).catch(() => {}), { timeout: 5000 })
      return () => w.cancelIdleCallback?.(id)
    }
    const t = setTimeout(() => void Promise.all([loadFilePreview(), loadFileTree()]).catch(() => {}), 2000)
    return () => clearTimeout(t)
  }, [])
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

/** The chat column's minimum beside the side pane (docs/RESPONSIVE.md §6). Matches the pane's CSS max-width. */
const CHAT_MIN = 440

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
  // The row the chat and the pane share. Re-measured when the window or the sidebar changes size, so a width saved on
  // a big monitor can never squeeze the chat on a smaller one.
  const [room, setRoom] = useState<number | null>(null)

  // 840–1199px: the sidebar steps down to its rail while the pane is open.
  useEffect(() => {
    setRail?.(true)
    return () => setRail?.(false)
  }, [setRail])

  useEffect(() => {
    const row = ref.current?.parentElement
    if (!row) return
    const measure = () => setRoom(row.clientWidth)
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    return () => ro.disconnect()
  }, [])

  // 320–1100px on large screens (and at most 70% of the window), and always whatever leaves the chat its 440px.
  // The saved width stays as it was: back on the big monitor, the pane is as wide as it was left there.
  const maxIn = (row: number) => {
    const large = window.matchMedia("(min-width: 75rem)").matches
    return Math.max(PANEL_MIN, Math.min(large ? 1100 : Infinity, row - CHAT_MIN, window.innerWidth * 0.7))
  }
  /** While dragging or switching width: measured now, not at the last render. */
  const max = () => maxIn(ref.current?.parentElement?.clientWidth ?? room ?? window.innerWidth)
  const clamp = (w: number) => Math.max(PANEL_MIN, Math.min(max(), w))
  // Before the first measure (server render, first paint) the CSS max-width keeps the same rule.
  const width = room === null ? (live ?? panel.width) : Math.max(PANEL_MIN, Math.min(maxIn(room), live ?? panel.width))

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: width }
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    setLive(clamp(drag.current.w + drag.current.x - e.clientX))
  }
  function onPointerUp() {
    if (!drag.current) return
    drag.current = null
    if (live !== null) panel.setWidth(live)
    setLive(null)
  }

  return (
    <aside ref={ref} style={{ width }} aria-label="Workspace panel" className="relative flex max-w-[min(75vw,calc(100%-440px))] shrink-0 flex-col border-l border-line bg-surface/50">
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
              <span className="max-w-[180px] truncate">{previewLabel(panel)}</span>
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

function previewLabel(panel: NonNullable<ReturnType<typeof usePanel>>): string {
  if (panel.block && "input" in panel.block) return `Preview · ${KINDS[panel.block.input.kind].label}`
  return panel.selected ? `Preview · ${panel.selected.split("/").pop()}` : "Preview"
}

/** The three tabs' content. All stay mounted, so switching keeps each tab's scroll and state. */
function PanelBody() {
  const panel = usePanel()!
  // A tab's body mounts the first time it shows and then stays (its scroll and state survive switching): a closed tab
  // never loads its chunk.
  const [seen, setSeen] = useState<ReadonlySet<PanelTab>>(() => new Set([panel.tab]))
  if (!seen.has(panel.tab)) setSeen(new Set([...seen, panel.tab]))
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
      <div className={show("files")}>{!seen.has("files") ? null : panel.target ? <FileTree key={`${panel.target.dir}|${panel.target.conn?.baseUrl ?? ""}|${panel.showHidden}`} target={panel.target} /> : waking}</div>
      <div className={show("preview")}>
        {!seen.has("preview") ? null : panel.block || panel.blockGone ? (
          <BlockPreview block={panel.block} />
        ) : !panel.selected ? (
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
