"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useEngine } from "@/lib/engine-store"
import {
  cloudExists,
  cloudRead,
  download,
  hostOS,
  isExecutable,
  isWindowsPath,
  localFileAction,
  resolveFile,
  revealLabel,
  type FileBody,
  type LocalAction,
  type WorkspaceFile,
} from "@/lib/file-actions"
import { useDismiss } from "@/lib/use-dismiss"
import { Brew } from "./brew"

/**
 * A file mention: click reveals it (local: a new File Explorer window with the
 * file selected; cloud: its contents), right-click opens a menu of actions.
 * Paths outside the workspace render as plain text.
 */
export function FileLink({ path, children, className = "" }: { path: string; children?: ReactNode; className?: string }) {
  const fm = useFileMenu(path)
  if (!fm.file) return <>{children ?? path}</>
  return (
    <>
      <button
        type="button"
        {...fm.bind}
        title={`${fm.file.abs}\n${fm.cloud ? "Click to view" : "Click to show in folder"} · right-click for more`}
        className={`cursor-pointer text-left underline decoration-muted/40 decoration-dotted underline-offset-[3px] transition hover:text-accent hover:decoration-accent focus-visible:rounded-sm focus-visible:outline-1 focus-visible:outline-accent ${className}`}
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

type Toast = { text: string; tone?: "warn"; at: number }
type Item = { label: string; hint?: string; run(): void } | "sep"

/** The behavior behind FileLink, for elements that already have their own click (e.g. a diff row): spread `bind.onContextMenu`, render `ui`. */
export function useFileMenu(path: string) {
  const { directory, connection } = useEngine()
  const file = useMemo(() => resolveFile(directory, path), [directory, path])
  const cloud = !!connection
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [viewing, setViewing] = useState<FileBody | "loading" | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const flash = useCallback((text: string, tone?: "warn") => setToast({ text, tone, at: Date.now() }), [])
  const hideToast = useCallback(() => setToast(null), [])

  const closeMenu = useCallback((refocus = true) => {
    setMenu(null)
    if (refocus) trigger.current?.focus()
  }, [])

  const missing = useCallback((f: WorkspaceFile) => flash(`${f.rel} doesn't exist yet`, "warn"), [flash])

  const local = useCallback(
    async (action: LocalAction) => {
      if (!file) return
      if (action === "open" && isExecutable(file.name, isWindowsPath(directory)) && !window.confirm(`Open ${file.name}?\n\nThis runs it as a program on your computer.`)) return
      const err = await localFileAction(directory, file.abs, action)
      if (err === "missing") missing(file)
      else if (err) flash(err, "warn")
    },
    [file, directory, flash, missing],
  )

  const view = useCallback(async () => {
    if (!file) return
    if (!(await cloudExists(directory, connection, file))) return missing(file)
    setViewing("loading")
    const body = await cloudRead(directory, connection, file)
    if (body) setViewing(body)
    else {
      setViewing(null)
      flash(`Could not read ${file.rel}`, "warn")
    }
  }, [file, directory, connection, flash, missing])

  const save = useCallback(async () => {
    if (!file) return
    if (!(await cloudExists(directory, connection, file))) return missing(file)
    const body = await cloudRead(directory, connection, file)
    if (body) download(file.name, body)
    else flash(`Could not read ${file.rel}`, "warn")
  }, [file, directory, connection, flash, missing])

  const copy = useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const ta = Object.assign(document.createElement("textarea"), { value: text })
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        ta.remove()
      }
      flash(`Copied ${what}`)
    },
    [flash],
  )

  const bind = {
    onClick(e: MouseEvent<HTMLElement>) {
      e.stopPropagation()
      trigger.current = e.currentTarget
      setAnchor(anchorOf(e.currentTarget))
      void (cloud ? view() : local("reveal"))
    },
    onContextMenu(e: MouseEvent<HTMLElement>) {
      if (!file) return
      e.preventDefault()
      e.stopPropagation()
      trigger.current = e.currentTarget
      setAnchor(anchorOf(e.currentTarget))
      // A keyboard-opened menu (Shift+F10) has no pointer position; anchor it under the element.
      const r = e.currentTarget.getBoundingClientRect()
      setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 })
    },
  }

  let ui: ReactNode = null
  if (file && (menu || toast || viewing)) {
    const os = hostOS()
    const items: Item[] = cloud
      ? [
          { label: "View file", run: () => void view() },
          { label: "Download", run: () => void save() },
        ]
      : [
          { label: revealLabel(os), run: () => void local("reveal") },
          { label: "Open", hint: isExecutable(file.name, isWindowsPath(directory)) ? "runs it" : undefined, run: () => void local("open") },
          { label: "Open containing folder", run: () => void local("folder") },
        ]
    items.push("sep", { label: "Copy path", run: () => void copy(file.abs, "path") }, { label: "Copy relative path", run: () => void copy(file.rel, "relative path") }, { label: "Copy file name", run: () => void copy(file.name, "file name") })
    // Portaled content still bubbles React events to the mention's ancestors (e.g. a tool row that toggles on click).
    const stop = (e: MouseEvent) => e.stopPropagation()
    ui = createPortal(
      <div className="contents" onClick={stop} onContextMenu={stop}>
        {menu && <Menu at={menu} title={file.rel} items={items} onClose={closeMenu} />}
        {toast && <ToastView key={toast.at} toast={toast} anchor={anchor} onDone={hideToast} />}
        {viewing && <Viewer file={file} body={viewing} onDownload={() => viewing !== "loading" && download(file.name, viewing)} onClose={() => setViewing(null)} />}
      </div>,
      document.body,
    )
  }

  return { file, cloud, bind, ui }
}

/** A short note next to the mention that was used; the bottom of the screen when there is no anchor. */
function ToastView({ toast, anchor, onDone }: { toast: Toast; anchor: Anchor | null; onDone(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const t = setTimeout(onDone, toast.tone ? 3500 : 1800)
    // Anchored to where the mention was; once the page scrolls that is somewhere else.
    window.addEventListener("scroll", onDone, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener("scroll", onDone, true)
    }
  }, [toast, onDone])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchor) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8))}px`
    el.style.top = `${anchor.bottom + 6 + r.height > window.innerHeight - 8 ? anchor.top - 6 - r.height : anchor.bottom + 6}px`
  }, [anchor])
  return (
    <div ref={ref} role="status" className={`fixed z-[70] max-w-[90vw] truncate rounded-lg ${anchor ? "" : "bottom-6 left-1/2 -translate-x-1/2"} border border-line bg-surface px-3 py-2 text-[12px] shadow-card ${toast.tone === "warn" ? "text-warn" : "text-ink-2"}`}>
      {toast.text}
    </div>
  )
}

function Menu({ at, title, items, onClose }: { at: { x: number; y: number }; title: string; items: Item[]; onClose(refocus?: boolean): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = useCallback(() => onClose(false), [onClose])
  useDismiss(ref, true, dismiss)

  // Keep it inside the viewport: flip up/left near the edges. Positioned through the DOM, no re-render.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y}px`
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus()
  }, [at])

  useEffect(() => {
    window.addEventListener("scroll", dismiss, true)
    window.addEventListener("resize", dismiss)
    window.addEventListener("blur", dismiss)
    return () => {
      window.removeEventListener("scroll", dismiss, true)
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("blur", dismiss)
    }
  }, [dismiss])

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

  return (
    <div ref={ref} data-layer role="menu" aria-label={title} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()} style={{ left: at.x, top: at.y }} className="pop fixed z-[60] w-[232px] overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-card">
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
              onClose()
              it.run()
            }}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition hover:bg-surface-2 focus-visible:bg-surface-2"
          >
            {it.label}
            {it.hint && <span className="text-[11px] text-muted">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  )
}

function Viewer({ file, body, onDownload, onClose }: { file: WorkspaceFile; body: FileBody | "loading"; onDownload(): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, true, onClose)
  const text = body !== "loading" && body.kind === "text" ? body.text : null
  const clipped = text && text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (truncated, download for the full file)` : text
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={file.rel}>
      <div ref={ref} data-layer className="rise flex max-h-[85vh] w-[min(880px,100%)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2" title={file.abs}>
            {file.rel}
          </span>
          <button type="button" onClick={onDownload} disabled={body === "loading"} className="rounded-lg px-2 py-1 text-xs text-ink-2 transition hover:bg-surface-2 hover:text-ink disabled:opacity-40">
            Download
          </button>
          <button type="button" autoFocus onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-ink-2 transition hover:bg-surface-2 hover:text-ink">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {body === "loading" ? (
            <div className="flex min-h-[160px] items-center justify-center p-4">
              <Brew mood="load" size="md" />
            </div>
          ) : clipped !== null ? (
            <pre className="p-3 font-mono text-[12px] leading-relaxed whitespace-pre text-ink-2">{clipped || <span className="text-muted">(empty file)</span>}</pre>
          ) : (
            <div className="p-4 text-xs text-muted">Binary file. Use Download to save it.</div>
          )}
        </div>
      </div>
    </div>
  )
}
