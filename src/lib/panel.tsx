"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { useEngine } from "./engine-store"
import { cleanRel, parentRel } from "./fs-rules"
import type { Target } from "./workspace-fs"

/**
 * The Files + Preview side panel's state, shared by the panel, its toggle
 * and file mentions in chat. Open/closed, width and "show hidden" persist in
 * localStorage; the selected file and expanded folders belong to the current
 * workspace and reset when it changes.
 */

export type PanelTab = "files" | "preview"
type Prefs = { open: boolean; width: number; showHidden: boolean }

const KEY = "syrup.panel"
const DEFAULTS: Prefs = { open: false, width: 440, showHidden: false }
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

type Ctx = Prefs & {
  target: Target | null
  tab: PanelTab
  selected: string | null
  expanded: Set<string>
  setTab(t: PanelTab): void
  toggle(): void
  setOpen(open: boolean): void
  setWidth(w: number): void
  setShowHidden(v: boolean): void
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
  const [tab, setTab] = useState<PanelTab>("files")
  const [sel, setSel] = useState<{ dir: string; rel: string } | null>(null)
  const [exp, setExp] = useState<{ dir: string; set: Set<string> }>({ dir: "", set: new Set([""]) })
  const cloud = !!workspaceId
  // Cloud: nothing to browse until the sandbox connection is up.
  const target = useMemo<Target | null>(() => (directory && (!cloud || connection) ? { dir: directory, conn: connection, workspaceId: workspaceId ?? null } : null), [directory, connection, cloud, workspaceId])
  const selected = sel && sel.dir === directory ? sel.rel : null
  const expanded = useMemo(() => (exp.dir === directory ? exp.set : new Set([""])), [exp, directory])

  const toggle = useCallback(() => writePrefs({ open: !readPrefs().open }), [])
  const setOpen = useCallback((open: boolean) => writePrefs({ open }), [])
  const setWidth = useCallback((width: number) => writePrefs({ width: Math.round(width) }), [])
  const setShowHidden = useCallback((showHidden: boolean) => writePrefs({ showHidden }), [])

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
      setTab(folder ? "files" : "preview")
      writePrefs({ open: true })
    },
    [directory],
  )

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

  const value: Ctx = { ...prefs, target, tab, selected, expanded, setTab, toggle, setOpen, setWidth, setShowHidden, openFile, toggleFolder }
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>
}

export function usePanel(): Ctx | null {
  return useContext(PanelContext)
}

export const PANEL_SHORTCUT = "Ctrl+\\ or ⌘\\"
