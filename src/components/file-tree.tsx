"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useEngine } from "@/lib/engine-store"
import { copyText, hostOS, localFileAction, revealLabel } from "@/lib/file-actions"
import { fmtBytes, joinRel, parentRel } from "@/lib/fs-rules"
import { usePanel } from "@/lib/panel"
import { useDismiss } from "@/lib/use-dismiss"
import { useLongPress } from "@/lib/use-long-press"
import { absPath, downloadFile, downloadZip, filesFromDrop, list, upload, type Entry, type Target, type Upload } from "@/lib/workspace-fs"
import { Brew } from "./brew"
import { Menu, type MenuItem } from "./file-link"
import { Button, Icon, IconButton } from "./ui/s"
import { MenuList, Popover } from "./ui/sheet"

/**
 * The Files tab's tree (docs/RESPONSIVE.md §6): browse, open in Preview, upload by drop or picker, download a file or
 * a folder as .zip, reveal on this computer. Its own chunk, loaded when the panel first shows Files: a chat with the
 * panel closed never needs it (docs/RENDERING.md decision 4, the initial-JS payback).
 */

type Dir = Entry[] | { error: string }
type Status = { text: string; tone?: "warn" | "ok"; busy?: boolean; at: number }

const REFRESH_DEBOUNCE_MS = 700
const POLL_MS = 15_000

export function FileTree({ target }: { target: Target }) {
  const panel = usePanel()!
  const { onFilesChanged } = useEngine()
  const { expanded, showHidden, selected } = panel
  const [dirs, setDirs] = useState<Record<string, Dir>>({})
  const [status, setStatus] = useState<Status | null>(null)
  const [drop, setDrop] = useState<string | null>(null)
  // Roving focus (role="tree"): the one row in the tab order. Arrow keys move it (onTreeKey).
  const [focusRel, setFocusRel] = useState<string | null>(null)
  // Kept (open: false) while the menu plays its exit, dropped once it has gone.
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null; open: boolean } | null>(null)
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
        // Hands over to the native file picker: the menu goes without its exit (docs/MOTION.md §4.3).
        handoff: true,
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
    setMenu({ x: ev.clientX || r.left, y: ev.clientY || r.bottom + 4, entry, open: true })
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    setDrop((e.target as HTMLElement).closest("[data-drop-dir]")?.getAttribute("data-drop-dir") ?? "")
  }

  function onDrop(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    const dir = drop ?? ""
    setDrop(null)
    // Entries must be taken from the DataTransfer before the first await.
    void filesFromDrop(e.dataTransfer, dir).then((items) => send(items, dir))
  }

  /** Arrow keys, Home/End, Right opens or goes in, Left closes or goes to the parent, Enter/Space opens (03 B11). */
  function onTreeKey(e: KeyboardEvent<HTMLUListElement>) {
    const cur = e.target as HTMLElement
    if (cur.getAttribute("role") !== "treeitem") return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const i = items.indexOf(cur)
    const level = Number(cur.getAttribute("aria-level"))
    const rel = cur.dataset.rel ?? ""
    const go = (el: HTMLElement | undefined) => {
      e.preventDefault()
      if (!el) return
      setFocusRel(el.dataset.rel ?? null)
      el.focus()
    }
    const expanded = cur.getAttribute("aria-expanded")
    if (e.key === "ArrowDown") go(items[i + 1])
    else if (e.key === "ArrowUp") go(items[i - 1])
    else if (e.key === "Home") go(items[0])
    else if (e.key === "End") go(items[items.length - 1])
    else if (e.key === "ArrowRight") {
      if (expanded === "false") {
        e.preventDefault()
        panel.toggleFolder(rel)
      } else if (expanded === "true" && Number(items[i + 1]?.getAttribute("aria-level")) > level) go(items[i + 1])
    } else if (e.key === "ArrowLeft") {
      if (expanded === "true") {
        e.preventDefault()
        panel.toggleFolder(rel)
      } else go(items.slice(0, i).reverse().find((it) => Number(it.getAttribute("aria-level")) === level - 1))
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      cur.click()
    }
  }

  /** Lines that are not rows (loading, error, empty) line up with the row names: base 8 + 16 per level + chevron and gap. */
  const inset = (depth: number): CSSProperties => ({ paddingLeft: 32 + depth * 16 })

  function rows(rel: string, depth: number): ReactNode {
    const d = dirs[rel]
    if (!d) return <TreeSkeleton key={`${rel}:loading`} style={inset(depth)} />
    if (!Array.isArray(d))
      return (
        <li key={`${rel}:error`} role="none" style={inset(depth)} className="flex flex-wrap items-center gap-x-2 py-1 pr-3">
          <span className="s-error-line">{d.error}</span>
          <Button variant="link-brand" size="sm" onClick={() => void load(rel)}>
            Retry
          </Button>
        </li>
      )
    if (d.length === 0)
      return (
        <li key={`${rel}:empty`} role="none" style={inset(depth)} className="py-2 pr-3">
          <p className="s-empty-line">{rel ? "Empty folder." : "Nothing here yet. Drop files to add them."}</p>
        </li>
      )
    const first = dirs[""]
    const firstRel = Array.isArray(first) ? first[0]?.rel : undefined
    const tabStop = focusRel ?? selected ?? firstRel
    return d.flatMap((e) => {
      const dir = e.type === "directory"
      const open = dir && expanded.has(e.rel)
      const row = (
        <Row
          key={e.rel}
          entry={e}
          depth={depth}
          open={open}
          active={selected === e.rel}
          tabbable={tabStop === e.rel}
          dropping={dir && drop === e.rel}
          onOpen={() => {
            setFocusRel(e.rel)
            if (dir) panel.toggleFolder(e.rel)
            else panel.openFile(e.rel)
          }}
          onMenu={(ev) => openMenu(ev, e)}
          onMenuAt={(x, y) => setMenu({ x, y, entry: e, open: true })}
        />
      )
      return open ? [row, rows(e.rel, depth + 1)] : [row]
    })
  }

  return (
    <>
      {/* Path bar (03 B11): Code body-sm faint crumbs, ghost sm toolbar buttons, a rule below inside the panel. */}
      <div className="s-pathbar flex shrink-0 items-center gap-1">
        <nav aria-label="Folder" className="s-crumbs min-w-0 flex-1">
          <ol>
            <li className="min-w-0">
              <span aria-current="page" title={target.dir} className="truncate">
                {rootName}
              </span>
            </li>
          </ol>
        </nav>
        <IconButton
          icon="upload"
          label="Upload files"
          onClick={() => {
            pickFor.current = ""
            picker.current?.click()
          }}
        />
        <IconButton icon="refresh-cw" label="Refresh" onClick={refresh} />
        <div ref={moreRef} className="relative">
          <IconButton icon="ellipsis" label="More" aria-pressed={more} aria-haspopup="menu" variant={more ? "secondary" : "ghost"} onClick={() => setMore((v) => !v)} />
          <Popover open={more} onClose={closeMore} title={rootName} side="down" className="s-raised s-raised--md absolute top-full right-0 z-dropdown mt-1 w-[260px]">
            <MenuList
              onDone={closeMore}
              items={[
                { label: showHidden ? "Hide .git, node_modules and caches" : "Show hidden folders", icon: <Icon name={showHidden ? "eye-off" : "eye"} />, hint: showHidden ? "On" : undefined, onSelect: () => panel.setShowHidden(!showHidden) },
                { label: `Download ${rootName} as .zip`, icon: <Icon name="download" />, onSelect: () => void zip("") },
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
      <ul
        role="tree"
        aria-label={`Files in ${rootName}`}
        data-drop-dir=""
        onKeyDown={onTreeKey}
        onDragOver={onDragOver}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}
        onDrop={onDrop}
        onContextMenu={(e) => openMenu(e, null)}
        // The whole tree takes a drop into the workspace root: the brand-tone drop colours (03 B11, B12), never dashed.
        className={`s-tree min-h-0 flex-1 overflow-auto overscroll-contain p-2 transition-colors ${drop === "" ? "bg-brand-tone outline -outline-offset-1 outline-line-brand" : ""}`}
      >
        {rows("", 0)}
      </ul>
      {status && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2">
          {status.busy ? <Brew label={status.text} timerAfter={3} /> : <span className={`min-w-0 truncate text-sm ${status.tone === "warn" ? "text-warn" : "text-ink-2"}`}>{status.text}</span>}
        </div>
      )}
      {menu &&
        createPortal(
          <Menu
            open={menu.open}
            at={{ x: menu.x, y: menu.y }}
            title={menu.entry?.rel || rootName}
            items={menuItems(menu.entry)}
            onClose={() => setMenu((m) => m && { ...m, open: false })}
            onExited={() => setMenu((m) => (m && !m.open ? null : m))}
          />,
          document.body,
        )}
    </>
  )
}

/**
 * One tree row (s-tree__row: 36, r12, indent 16 per level, faint icons, inset focus ring). The treeitem is the row's
 * <li>: tap opens; right-click, a long press or the ⋯ (always there on touch, on hover with a mouse) gives the actions.
 */
function Row({
  entry,
  depth,
  open,
  active,
  tabbable,
  dropping,
  onOpen,
  onMenu,
  onMenuAt,
}: {
  entry: Entry
  depth: number
  open: boolean
  active: boolean
  tabbable: boolean
  dropping: boolean
  onOpen(): void
  onMenu(e: ReactMouseEvent): void
  onMenuAt(x: number, y: number): void
}) {
  const dir = entry.type === "directory"
  const press = useLongPress<HTMLLIElement>((x, y) => onMenuAt(x, y))
  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={dir ? open : undefined}
      aria-selected={active}
      tabIndex={tabbable ? 0 : -1}
      data-rel={entry.rel}
      data-drop-dir={dir ? entry.rel : parentRel(entry.rel)}
      title={entry.rel}
      {...press}
      onClick={onOpen}
      onContextMenu={onMenu}
      className="[-webkit-touch-callout:none] pointer-coarse:select-none"
    >
      {/* 44px rows on touch screens: a touch-target size, the one change to the shared row. */}
      <div className="s-tree__row" data-drop={dropping || undefined}>
        {dir ? <Icon name="chevron-right" className="s-tree__chevron" /> : <span className="s-tree__spacer" />}
        <Icon name={dir ? (open ? "folder-open" : "folder") : "file-text"} className="s-tree__icon" />
        <span className={`s-tree__name ${entry.ignored ? "text-muted" : ""}`}>{entry.name}</span>
        <span className="s-tree__actions">
          <IconButton
            icon="ellipsis"
            label={`Actions for ${entry.name}`}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              onMenu(e)
            }}
          />
        </span>
      </div>
    </li>
  )
}

function TreeSkeleton({ style }: { style: CSSProperties }) {
  return (
    <li role="none" className="skel-in py-2 pr-3" style={style}>
      <div aria-busy className="s-skeleton-stack">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="s-skeleton s-skeleton--line" />
        ))}
      </div>
    </li>
  )
}
