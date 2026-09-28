"use client"

import { useParams } from "next/navigation"
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { useEngine } from "./engine-store"
import { cleanRel, parentRel } from "./fs-rules"
import { useNarrow } from "./use-window-class"
import type { Target } from "./workspace-fs"

/**
 * The workspace panel's state (Changes · Files · Preview), shared by the panel,
 * its toggles and file mentions in chat. Desktop: open/closed, width and view
 * options persist in localStorage. Phones and tablets: the panel is a
 * full-screen layer and the URL says whether it's up (`?panel=files`,
 * `?panel=preview&file=…`, `?panel=changes&file=…`), so the back button or
 * back swipe closes it instead of leaving the chat. The selected file and
 * expanded folders belong to the current workspace and reset when it changes.
 */

export type PanelTab = "changes" | "files" | "preview"
export const PANEL_TABS: readonly PanelTab[] = ["changes", "files", "preview"]
type Prefs = { open: boolean; width: number; showHidden: boolean; wrap: boolean }

const KEY = "syrup.panel"
const DEFAULTS: Prefs = { open: false, width: 440, showHidden: false, wrap: true }
export const PANEL_MIN = 320
export const PANEL_WIDE = 680

let cache: Prefs | null = null
const subs = new Set<() => void>()

function readPrefs(): Prefs {
  if (!cache) {
    try {
      cache = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) }
    } catch {
      cache = DEFAULTS
    }
  }
  return cache
}

function writePrefs(p: Partial<Prefs>) {
  cache = { ...readPrefs(), ...p }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {}
  for (const f of subs) f()
}

function subscribe(f: () => void) {
  subs.add(f)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    cache = null
    f()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    subs.delete(f)
    window.removeEventListener("storage", onStorage)
  }
}

const serverPrefs = () => DEFAULTS

// ---- The phone/tablet layer in the URL ----
// Native pushState/replaceState: Next folds them into its router (usePathname/useSearchParams stay in
// sync, nothing is refetched, the chat isn't remounted). useSearchParams itself would need a Suspense
// boundary above this provider, which wraps static pages too.

type Layer = { tab: PanelTab; file: string | null }
/** How many history entries the layer pushed on top of the chat (1 = opened, 2 = drilled into a diff). */
type HistoryMark = { syrupPanel?: number }

const URL_EVENT = "syrup:panel-url"
/** Matches the `expanded:` breakpoint: from here the panel is a side pane and the URL stays clean. */
const EXPANDED_QUERY = "(min-width: 52.5rem)"
const isNarrow = () => !window.matchMedia(EXPANDED_QUERY).matches

/** A history.go is in flight: until its popstate lands the URL is stale, so a second tap must not go back again. */
let unwinding = false
const settled = () => {
  unwinding = false
}

function subscribeUrl(f: () => void) {
  window.addEventListener("popstate", settled)
  window.addEventListener("popstate", f)
  window.addEventListener(URL_EVENT, f)
  return () => {
    window.removeEventListener("popstate", f)
    window.removeEventListener(URL_EVENT, f)
  }
}
const readSearch = () => window.location.search
const serverSearch = () => ""

function parseLayer(search: string): Layer | null {
  const q = new URLSearchParams(search)
  const tab = q.get("panel") as PanelTab | null
  if (!tab || !PANEL_TABS.includes(tab)) return null
  return { tab, file: q.get("file") || null }
}

const currentLayer = () => parseLayer(window.location.search)

function layerHref(layer: Layer | null): string {
  const u = new URL(window.location.href)
  u.searchParams.delete("panel")
  u.searchParams.delete("file")
  if (layer) {
    u.searchParams.set("panel", layer.tab)
    if (layer.file) u.searchParams.set("file", layer.file)
  }
  return `${u.pathname}${u.search}${u.hash}`
}

const depth = () => (window.history.state as HistoryMark | null)?.syrupPanel ?? 0

function writeUrl(mode: "push" | "replace", layer: Layer | null, mark: number, notify = true) {
  const data: HistoryMark = { syrupPanel: mark }
  if (mode === "push") window.history.pushState(data, "", layerHref(layer))
  else window.history.replaceState(data, "", layerHref(layer))
  if (notify) window.dispatchEvent(new Event(URL_EVENT))
}

function unwind(n: number) {
  unwinding = true
  window.history.go(-n)
  // Never stay stuck if the traversal doesn't happen (popstate normally lands within a frame or two).
  setTimeout(settled, 800)
}

type Ctx = Omit<Prefs, "open"> & {
  target: Target | null
  /** The chat on screen (local /s/[id], cloud /w/[id]/s/[sid]); null on the new-chat screen. */
  sessionID: string | null
  /** Desktop: the persisted preference. Phones and tablets: whether the layer is in the URL. */
  open: boolean
  tab: PanelTab
  selected: string | null
  expanded: Set<string>
  /** The changed file whose diff the Changes tab shows. */
  diff: string | null
  setTab(t: PanelTab): void
  /** Switches to a tab and opens the panel. */
  openTab(t: PanelTab): void
  toggle(): void
  setOpen(open: boolean): void
  setWidth(w: number): void
  setShowHidden(v: boolean): void
  setWrap(v: boolean): void
  /** Shows a file's diff in the Changes tab (null: back to the list). On phones this is a history entry, so back returns to the list. */
  showDiff(file: string | null): void
  /** Opens a workspace file (absolute or relative) in Preview; a folder path ("src/") shows it in Files. */
  openFile(path: string, opts?: { folder?: boolean }): void
  toggleFolder(rel: string): void
}

const PanelContext = createContext<Ctx | null>(null)

export const PREFILL_EVENT = "syrup:prefill"

/** Puts text in the chat composer (e.g. "ask the agent for a web version"). */
export function prefillComposer(text: string) {
  window.dispatchEvent(new CustomEvent(PREFILL_EVENT, { detail: text }))
}

function ancestors(rel: string): string[] {
  const out = [""]
  let p = parentRel(rel)
  while (p) {
    out.push(p)
    p = parentRel(p)
  }
  return out
}

/** `workspaceId` marks cloud mode (the sandbox's routes); absent means local. */
export function PanelProvider({ workspaceId, children }: { workspaceId?: string; children: ReactNode }) {
  const { directory, connection } = useEngine()
  const prefs = useSyncExternalStore(subscribe, readPrefs, serverPrefs)
  const search = useSyncExternalStore(subscribeUrl, readSearch, serverSearch)
  const params = useParams<{ id?: string; sid?: string }>()
  const narrow = useNarrow()
  const [tabState, setTabState] = useState<PanelTab>("files")
  const [sel, setSel] = useState<{ dir: string; rel: string } | null>(null)
  const [exp, setExp] = useState<{ dir: string; set: Set<string> }>({ dir: "", set: new Set([""]) })
  const [diffState, setDiffState] = useState<{ sid: string | null; file: string | null }>({ sid: null, file: null })
  const cloud = !!workspaceId
  const sessionID = (cloud ? params?.sid : params?.id) ?? null
  // Cloud: nothing to browse until the sandbox connection is up.
  const target = useMemo<Target | null>(() => (directory && (!cloud || connection) ? { dir: directory, conn: connection, workspaceId: workspaceId ?? null } : null), [directory, connection, cloud, workspaceId])
  const expanded = useMemo(() => (exp.dir === directory ? exp.set : new Set([""])), [exp, directory])
  const remembered = sel && sel.dir === directory ? sel.rel : null

  // On phones and tablets the URL is the truth while the layer is up; component state is the memory for next time.
  const layer = useMemo(() => (narrow ? parseLayer(search) : null), [narrow, search])
  const open = narrow ? !!layer : prefs.open
  const tab = layer?.tab ?? tabState
  const selected = layer?.tab === "preview" && layer.file ? layer.file : remembered
  const diff = layer ? (layer.tab === "changes" ? layer.file : null) : diffState.sid === sessionID ? diffState.file : null

  /** Puts the layer in the URL: a new history entry when it opens, a replacement while it's up. */
  const showLayer = useCallback((next: Layer) => {
    if (unwinding) return
    if (currentLayer()) writeUrl("replace", next, depth())
    else writeUrl("push", next, 1)
  }, [])

  const closeLayer = useCallback(() => {
    if (unwinding) return
    const d = depth()
    // Unwind what we pushed, so the next back leaves the chat as usual instead of reopening the panel.
    if (d > 0) unwind(d)
    else writeUrl("replace", null, 0)
  }, [])

  const openTab = useCallback(
    (t: PanelTab) => {
      setTabState(t)
      if (!isNarrow()) return writePrefs({ open: true })
      showLayer({ tab: t, file: t === "preview" ? remembered : null })
    },
    [remembered, showLayer],
  )

  const setTab = useCallback(
    (t: PanelTab) => {
      setTabState(t)
      if (isNarrow() && currentLayer() && !unwinding) writeUrl("replace", { tab: t, file: t === "preview" ? remembered : null }, depth())
    },
    [remembered],
  )

  const setOpen = useCallback(
    (v: boolean) => {
      if (!isNarrow()) return writePrefs({ open: v })
      if (v) openTab(tabState)
      else if (currentLayer()) closeLayer()
    },
    [openTab, tabState, closeLayer],
  )

  const toggle = useCallback(() => {
    if (!isNarrow()) return writePrefs({ open: !readPrefs().open })
    if (currentLayer()) closeLayer()
    else openTab(tabState)
  }, [openTab, tabState, closeLayer])

  const setWidth = useCallback((width: number) => writePrefs({ width: Math.round(width) }), [])
  const setShowHidden = useCallback((showHidden: boolean) => writePrefs({ showHidden }), [])
  const setWrap = useCallback((wrap: boolean) => writePrefs({ wrap }), [])

  const showDiff = useCallback(
    (file: string | null) => {
      setDiffState({ sid: sessionID, file })
      const cur = currentLayer()
      if (!isNarrow() || !cur || unwinding) return
      // Drilling in from the list is its own history entry, and it always sits on the list's entry.
      if (file && cur.tab === "changes" && !cur.file) writeUrl("push", { tab: "changes", file }, depth() + 1)
      else if (!file && cur.file && depth() > 1) unwind(1)
      else writeUrl("replace", { tab: "changes", file }, depth())
    },
    [sessionID],
  )

  const toggleFolder = useCallback(
    (rel: string) =>
      setExp((e) => {
        const set = new Set(e.dir === directory ? e.set : [""])
        if (set.has(rel)) set.delete(rel)
        else set.add(rel)
        return { dir: directory, set }
      }),
    [directory],
  )

  const openFile = useCallback(
    (path: string, opts?: { folder?: boolean }) => {
      if (!directory) return
      const win = /^[a-z]:[\\/]/i.test(directory) || directory.includes("\\")
      const norm = (s: string) => (win ? s.replace(/\\/g, "/").toLowerCase() : s)
      const root = norm(directory).replace(/\/+$/, "")
      let p = path.replace(/:\d+(?::\d+)?$/, "")
      const np = norm(p)
      if (np === root) p = ""
      else if (np.startsWith(`${root}/`)) p = p.slice(root.length + 1)
      const folder = opts?.folder || /[\\/]$/.test(path)
      const rel = cleanRel(p)
      if (rel === null) return
      setExp((e) => {
        const set = new Set(e.dir === directory ? e.set : [""])
        for (const a of ancestors(rel)) set.add(a)
        if (folder) set.add(rel)
        return { dir: directory, set }
      })
      if (!folder) setSel({ dir: directory, rel })
      setTabState(folder ? "files" : "preview")
      if (isNarrow()) showLayer(folder ? { tab: "files", file: null } : { tab: "preview", file: rel })
      else writePrefs({ open: true })
    },
    [directory, showLayer],
  )

  // A layer URL on a wide window (a shared link, or the window grew past the breakpoint) becomes the side
  // pane: take its tab and file here, while rendering; the effect below opens the pane and cleans the URL.
  const wideLayer = narrow ? null : parseLayer(search)
  const [adopted, setAdopted] = useState<string | null>(null)
  if (wideLayer && adopted !== search) {
    setAdopted(search)
    setTabState(wideLayer.tab)
    if (wideLayer.file && wideLayer.tab === "preview" && directory) setSel({ dir: directory, rel: wideLayer.file })
    if (wideLayer.file && wideLayer.tab === "changes") setDiffState({ sid: sessionID, file: wideLayer.file })
  } else if (!wideLayer && adopted !== null) setAdopted(null)

  // A layer URL nobody pushed: a shared link, a reload, or the window crossing the breakpoint. Checks the
  // media query itself, because during hydration `narrow` is still the server's guess.
  useEffect(() => {
    const l = parseLayer(search)
    if (!l) return
    if (isNarrow()) {
      if (depth() > 0) return
      // Rebuild the history as if it had been opened here (chat, layer, then the diff), so ✕ and back behave.
      writeUrl("replace", null, 0, false)
      if (l.tab === "changes" && l.file) {
        writeUrl("push", { tab: "changes", file: null }, 1, false)
        writeUrl("push", l, 2)
      } else writeUrl("push", l, 1)
      return
    }
    writePrefs({ open: true })
    writeUrl("replace", null, 0)
  }, [search, narrow])

  // Ctrl+\ (Cmd+\ on a Mac) toggles the panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])

  const value: Ctx = {
    ...prefs,
    open,
    target,
    sessionID,
    tab,
    selected,
    expanded,
    diff,
    setTab,
    openTab,
    toggle,
    setOpen,
    setWidth,
    setShowHidden,
    setWrap,
    showDiff,
    openFile,
    toggleFolder,
  }
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>
}

export function usePanel(): Ctx | null {
  return useContext(PanelContext)
}

export const PANEL_SHORTCUT = "Ctrl+\\ or ⌘\\"
