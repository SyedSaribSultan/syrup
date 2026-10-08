"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useEngine } from "@/lib/engine-store"
import { cloudExists, cloudRead, copyText, download, hostOS, isExecutable, isWindowsPath, localFileAction, resolveFile, revealLabel, type LocalAction, type WorkspaceFile } from "@/lib/file-actions"
import { usePanel } from "@/lib/panel"
import { useDismiss } from "@/lib/use-dismiss"
import { useLongPress } from "@/lib/use-long-press"
import { restartEntrance, usePresence } from "@/lib/use-presence"
import { useNarrow } from "@/lib/use-window-class"
import { useReadOnly } from "./read-only"
import { confirmDialog } from "./ui/dialog"
import { Notice, useNotices } from "./ui/notice"
import { MenuList, Sheet } from "./ui/sheet"

/**
 * A file mention: click reveals it (local: a new File Explorer window with the
 * file selected; cloud: opens it in the Files panel), right-click or a long
 * press opens a menu of actions. Paths outside the workspace render as plain text.
 */
export function FileLink(props: { path: string; children?: ReactNode; className?: string }) {
  // A shared snapshot has no engine and no files: the mention is plain text.
  if (useReadOnly()) return <span className={props.className}>{props.children ?? props.path}</span>
  return <LiveFileLink {...props} />
}

function LiveFileLink({ path, children, className = "" }: { path: string; children?: ReactNode; className?: string }) {
  const fm = useFileMenu(path)
  if (!fm.file) return <>{children ?? path}</>
  return (
    <>
      <button
        type="button"
        {...fm.bind}
        title={`${fm.file.abs}\n${fm.cloud ? "Click to open in the panel" : "Click to show in folder"} · right-click for more`}
        className={`cursor-pointer text-left underline decoration-muted/40 decoration-dotted underline-offset-[3px] transition [-webkit-touch-callout:none] hover:text-accent hover:decoration-accent focus-visible:rounded-sm focus-visible:outline-1 focus-visible:outline-accent ${className}`}
      >
        {children ?? (fm.file.rel === "." ? fm.file.name : fm.file.rel)}
      </button>
      {fm.ui}
    </>
  )
}

type Anchor = { left: number; top: number; bottom: number }
const anchorOf = (el: HTMLElement): Anchor => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, bottom: r.bottom }
}

type Toast = { text: string; tone?: "warn"; anchor: Anchor | null }
/** `handoff`: choosing it hands over to something that is not one of our overlays, so the menu skips its exit (docs/MOTION.md §4.3). */
export type MenuItem = { label: string; hint?: string; run(): void; handoff?: boolean } | "sep"
type Item = MenuItem

/**
 * The behavior behind FileLink. Elements that already have their own click (e.g. a diff row) spread
 * `bind.onContextMenu` and `press` (long-press on touch), call `openAt` from a visible ⋯, and render `ui`.
 */
export function useFileMenu(path: string) {
  const { directory, connection } = useEngine()
  const panel = usePanel()
  const file = useMemo(() => resolveFile(directory, path), [directory, path])
  const cloud = !!connection
  // Kept (open: false) while the menu plays its exit, dropped once it has gone.
  const [menu, setMenu] = useState<{ x: number; y: number; open: boolean } | null>(null)
  const toasts = useNotices<Toast>()
  // The mention (or row) that was used: a toast shows next to it.
  const trigger = useRef<HTMLElement | null>(null)
  const { show: showToast, hide: hideToast, drop: dropToast, current: toast } = toasts
  // Measured when the toast shows, not when the mention was clicked: the click's own handler shows some toasts before
  // a re-render, and the page may have scrolled since.
  const flash = useCallback(
    (text: string, tone?: "warn") => {
      const el = trigger.current
      showToast({ text, tone, anchor: el?.isConnected ? anchorOf(el) : null })
    },
    [showToast],
  )

  const closeMenu = useCallback((refocus = true) => {
    setMenu((m) => (m?.open ? { ...m, open: false } : m))
    if (refocus) trigger.current?.focus()
  }, [])
  const menuGone = useCallback(() => setMenu((m) => (m && !m.open ? null : m)), [])

  // The open toast hides after a moment, or as soon as the page scrolls: it is anchored to where the mention was.
  const toastId = toast?.id
  const toastTone = toast?.tone
  useEffect(() => {
    if (toastId === undefined) return
    const hide = () => hideToast(toastId)
    const t = setTimeout(hide, toastTone ? 3500 : 1800)
    window.addEventListener("scroll", hide, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener("scroll", hide, true)
    }
  }, [toastId, toastTone, hideToast])

  const missing = useCallback((f: WorkspaceFile) => flash(`${f.rel} doesn't exist yet`, "warn"), [flash])

  const local = useCallback(
    async (action: LocalAction) => {
      if (!file) return
      if (action === "open" && isExecutable(file.name, isWindowsPath(directory)) && !(await confirmDialog({ title: `Open ${file.name}?`, body: "This runs it as a program on your computer.", confirmLabel: "Open", danger: true }))) return
      const err = await localFileAction(directory, file.abs, action)
      if (err === "missing") missing(file)
      else if (err) flash(err, "warn")
    },
    [file, directory, flash, missing],
  )

  const save = useCallback(async () => {
    if (!file) return
    if (!(await cloudExists(directory, connection, file))) return missing(file)
    const body = await cloudRead(directory, connection, file)
    if (body) download(file.name, body)
    else flash(`Could not read ${file.rel}`, "warn")
  }, [file, directory, connection, flash, missing])

  const copy = useCallback(
    async (text: string, what: string) => {
      await copyText(text)
      flash(`Copied ${what}`)
    },
    [flash],
  )

  /** Opens the menu at a point (a long press, or under a ⋯ button); `el` gets focus back when it closes. */
  const openAt = useCallback(
    (x: number, y: number, el: HTMLElement) => {
      if (!file) return
      trigger.current = el
      setMenu({ x, y, open: true })
    },
    [file],
  )
  const press = useLongPress<HTMLElement>(openAt)

  const bind = {
    ...press,
    onClick(e: MouseEvent<HTMLElement>) {
      e.stopPropagation()
      trigger.current = e.currentTarget
      // In the cloud every mention sits inside the workspace's panel (workspace-view.tsx), which shows the file.
      if (cloud) panel?.openFile(path)
      else void local("reveal")
    },
    onContextMenu(e: MouseEvent<HTMLElement>) {
      if (!file) return
      e.preventDefault()
      e.stopPropagation()
      // A keyboard-opened menu (Shift+F10) has no pointer position; anchor it under the element.
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientX || e.clientY) openAt(e.clientX, e.clientY, e.currentTarget)
      else openAt(r.left, r.bottom + 4, e.currentTarget)
    },
  }

  let ui: ReactNode = null
  if (file && (menu || toasts.items.length)) {
    const os = hostOS()
    // Opening the panel hands over to it (the full-screen layer on phones), so the menu goes without its exit.
    const inPanel: Item[] = panel ? [{ label: "Open in panel", run: () => panel.openFile(path), handoff: true }] : []
    // One literal, not a push: the actions reach a ref (the toast's anchor, read when it shows), and the React compiler
    // reads passing them to a function during render as reading that ref (react-hooks/refs).
    const items: Item[] = [
      ...(cloud
        ? [...inPanel, { label: "Download", run: () => void save() }]
        : [
            { label: revealLabel(os), run: () => void local("reveal") },
            ...inPanel,
            { label: "Open", hint: isExecutable(file.name, isWindowsPath(directory)) ? "runs it" : undefined, run: () => void local("open") },
            { label: "Open containing folder", run: () => void local("folder") },
          ]),
      "sep",
      { label: "Copy path", run: () => void copy(file.abs, "path") },
      { label: "Copy relative path", run: () => void copy(file.rel, "relative path") },
      { label: "Copy file name", run: () => void copy(file.name, "file name") },
    ]
    // Portaled content still bubbles React events to the mention's ancestors (e.g. a tool row that toggles on click).
    const stop = (e: MouseEvent) => e.stopPropagation()
    ui = createPortal(
      <div className="contents" onClick={stop} onContextMenu={stop}>
        {menu && <Menu open={menu.open} at={menu} title={file.rel} items={items} onClose={closeMenu} onExited={menuGone} />}
        {toasts.items.map((t) => (
          <Notice
            key={t.id}
            open={t.open}
            onExited={() => dropToast(t.id)}
            place={t.anchor ? (el) => placeToast(el, t.anchor!) : undefined}
            className={`fixed z-[70] max-w-[90vw] truncate rounded-lg ${t.anchor ? "" : "bottom-[calc(env(safe-area-inset-bottom)+96px)] left-1/2 -translate-x-1/2 expanded:bottom-6"} border border-line bg-surface px-3 py-2 text-[12px] shadow-card ${t.tone === "warn" ? "text-warn" : "text-ink-2"}`}
          >
            {t.text}
          </Notice>
        ))}
      </div>,
      document.body,
    )
  }

  return { file, cloud, bind, press, openAt, ui }
}

/**
 * A toast next to the mention that was used: under it, or above it when there is no room below. It drops in under the
 * mention and rises above it. With no anchor it sits bottom centre (on phones above the composer and the home indicator).
 */
function placeToast(el: HTMLElement, anchor: Anchor): "up" | "down" {
  const r = el.getBoundingClientRect()
  const above = anchor.bottom + 6 + r.height > window.innerHeight - 8
  el.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8))}px`
  el.style.top = `${above ? anchor.top - 6 - r.height : anchor.bottom + 6}px`
  return above ? "up" : "down"
}

/** The file actions: an anchored menu at the pointer on desktop, an action sheet (big rows) on phones and tablets. */
export function Menu(props: { open: boolean; at: { x: number; y: number }; title: string; items: Item[]; onClose(refocus?: boolean): void; onExited(): void }) {
  const narrow = useNarrow()
  if (!narrow) return <PointerMenu {...props} />
  const done = () => props.onClose(false)
  return (
    <Sheet open={props.open} onClose={done} onExited={props.onExited} title={<span className="block truncate font-mono text-[13px] font-normal text-ink-2">{props.title.split(/[\\/]/).pop() || props.title}</span>} label={props.title}>
      <MenuList items={props.items.map((it) => (it === "sep" ? ("divider" as const) : { label: it.label, hint: it.hint, onSelect: it.run, handoff: it.handoff }))} onDone={done} />
    </Sheet>
  )
}

/**
 * At the pointer; flipped up when there is no room below, clamped left near the right edge. It fades in and travels
 * from that side, like a Popover (docs/MOTION.md §4.5). The side is known only after measuring, so the layout effect
 * writes it before paint and restarts the entrance from it.
 */
function PointerMenu({ open, at, title, items, onClose, onExited }: { open: boolean; at: { x: number; y: number }; title: string; items: Item[]; onClose(refocus?: boolean): void; onExited(): void }) {
  const p = usePresence<HTMLDivElement>(open, { onExited, handoff: true })
  const { mounted, ref } = p
  const dismiss = useCallback(() => onClose(false), [onClose])
  useDismiss(ref, open, dismiss)

  // Keep it inside the viewport: flip up/left near the edges. Positioned through the DOM, no re-render.
  // Each open (not each mount) plays the entrance and focuses the first item: a right-click on another row while the
  // menu is open or still leaving opens it again at the new spot without unmounting it.
  const entered = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !mounted || !el) {
      // Closing (it stays where it is while it fades) or gone: the next open plays the entrance again.
      entered.current = false
      return
    }
    const r = el.getBoundingClientRect()
    const up = at.y + r.height > window.innerHeight - 8
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${up ? Math.max(8, at.y - r.height) : at.y}px`
    el.dataset.side = up ? "up" : "down"
    if (entered.current) return
    entered.current = true
    restartEntrance(el)
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus()
  }, [at, mounted, open, ref])

  useEffect(() => {
    if (!open) return
    window.addEventListener("scroll", dismiss, true)
    window.addEventListener("resize", dismiss)
    window.addEventListener("blur", dismiss)
    return () => {
      window.removeEventListener("scroll", dismiss, true)
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("blur", dismiss)
    }
  }, [open, dismiss])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      all[(n + all.length) % all.length]?.focus()
    }
    if (e.key === "ArrowDown") go(i + 1)
    else if (e.key === "ArrowUp") go(i - 1)
    else if (e.key === "Home") go(0)
    else if (e.key === "End") go(all.length - 1)
    else if (e.key === "Escape") onClose()
    else if (e.key === "Tab") onClose(false)
  }

  if (!mounted) return null
  return (
    <div
      {...p.props}
      data-layer
      role="menu"
      aria-label={title}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: at.x, top: at.y }}
      className="fixed z-[60] w-[232px] overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-card motion-pop"
    >
      <div className="truncate px-2.5 pt-1 pb-1.5 font-mono text-[11px] text-muted" title={title}>
        {title}
      </div>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} role="separator" className="my-1 border-t border-line" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            onClick={() => {
              if (it.handoff) p.skipExit()
              onClose()
              it.run()
            }}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition hover:bg-surface-2 focus-visible:bg-surface-2 pointer-coarse:py-3"
          >
            {it.label}
            {it.hint && <span className="text-[11px] text-muted">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  )
}
