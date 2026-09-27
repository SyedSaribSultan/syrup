"use client"

import { usePathname, useRouter } from "next/navigation"
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useEngine, useOptionalEngine } from "./engine-store"
import { localHomePath, prewarmSandbox } from "./home"
import { oc } from "./oc"
import { LIMIT_MESSAGE, MAX_WORKSPACES, nextColor, placeHome, type LocalEntry } from "./workspace-limits"

/**
 * The user's workspaces and their chats, with one shape in both modes so the
 * sidebar and switcher are the same component everywhere.
 * - Local: a workspace is a folder, kept in localStorage; chats come from the engine per folder.
 * - Cloud: a workspace is a row in Postgres; chats come from chat_sessions (no sandbox has to wake).
 * The active workspace's chats are overlaid live from the engine by the sidebar.
 * Both modes have a Home workspace (src/lib/home.ts): listed first, never removed, the default for new chats.
 */

export type WorkspaceItem = { id: string; name: string; color: number; detail: string; home: boolean }
export type ChatItem = { id: string; title: string; workspaceId: string; updated: number }
export type CloudUser = { name: string | null; email: string | null; image: string | null; admin: boolean }
export type AddInput = { path: string } | { repoUrl?: string; name?: string }

type Ctx = {
  mode: "local" | "cloud"
  /** Null until loaded. */
  workspaces: WorkspaceItem[] | null
  activeId: string | null
  /** Chats of every workspace. May be stale for the active one; the sidebar overlays the engine's live list. */
  chats: ChatItem[]
  full: boolean
  user: CloudUser | null
  /** Make a workspace active without navigating (a chat link does the navigation). */
  select(id: string): void
  /** Make a workspace active and go to its new-chat screen. */
  open(id: string): void
  chatHref(c: ChatItem): string
  newChatHref: string | null
  homeId: string | null
  /** Resolves to an error message, or null on success. */
  add(input: AddInput): Promise<string | null>
  remove(id: string): Promise<void>
}

const WorkspacesContext = createContext<Ctx | null>(null)

export function useWorkspaces(): Ctx {
  const ctx = useContext(WorkspacesContext)
  if (!ctx) throw new Error("useWorkspaces outside a workspaces provider")
  return ctx
}

/** Every chat of every listed workspace, newest first; the active workspace's come live from the engine. */
export function useAllChats(): ChatItem[] {
  const w = useWorkspaces()
  const engine = useOptionalEngine()
  return useMemo(() => {
    const ids = new Set(w.workspaces?.map((x) => x.id) ?? [])
    const live = engine?.sessionsLoaded && w.activeId ? w.activeId : null
    const rest = live ? w.chats.filter((c) => c.workspaceId !== live) : w.chats
    const mine: ChatItem[] = live
      ? Object.values(engine!.sessions)
          .filter((s) => !s.parentID && (w.mode === "cloud" || samePath(s.directory, engine!.directory)))
          .map((s) => ({ id: s.id, title: s.title, workspaceId: live, updated: s.time.updated ?? s.time.created }))
      : []
    return [...rest, ...mine].filter((c) => ids.has(c.workspaceId)).sort((a, b) => b.updated - a.updated)
  }, [engine, w.activeId, w.chats, w.mode, w.workspaces])
}

/** Soft tinted background for a workspace tile. */
export const wsTint = (color: number, pct = 16) => `color-mix(in srgb, ${wsColor(color)} ${pct}%, transparent)`

export const wsColor = (color: number) => `var(--ws-${((color % MAX_WORKSPACES) + MAX_WORKSPACES) % MAX_WORKSPACES})`

/** Folder paths compare case-insensitively on Windows and ignore slash style. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[a-z]:/i.test(s) ? s.toLowerCase() : s
  }
  return n(a) === n(b)
}

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Refetch when the tab regains focus: chats may have changed in another tab or workspace. */
function useFocusTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const on = () => document.visibilityState === "visible" && setTick((t) => t + 1)
    document.addEventListener("visibilitychange", on)
    return () => document.removeEventListener("visibilitychange", on)
  }, [])
  return tick
}

// ---------------------------------------------------------------- local

const LOCAL_KEY = "syrup.workspaces"
const LEGACY_RECENT_KEY = "syrup.recentDirs"
const DIR_KEY = "syrup.directory"

function readLocal(): LocalEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (raw) {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) return list.filter((x) => typeof x?.path === "string" && typeof x?.color === "number").slice(0, MAX_WORKSPACES)
    }
    // First run with workspaces: carry over the old recent-folders list.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_RECENT_KEY) ?? "[]")
    const paths = Array.isArray(legacy) ? legacy.filter((x): x is string => typeof x === "string") : []
    return paths.slice(0, MAX_WORKSPACES).map((path, color) => ({ path, color }))
  } catch {
    return []
  }
}

function writeLocal(list: LocalEntry[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list))
  } catch {}
}

function savedDirectory(): string {
  try {
    return localStorage.getItem(DIR_KEY) ?? ""
  } catch {
    return ""
  }
}

export function LocalWorkspacesProvider({ children }: { children: ReactNode }) {
  const { directory, setDirectory, connection } = useEngine()
  const router = useRouter()
  const [stored, setStored] = useState<LocalEntry[] | null>(null)
  const [home, setHome] = useState<string | null>(null)
  const [others, setOthers] = useState<ChatItem[]>([])
  const tick = useFocusTick()

  const save = useCallback((next: LocalEntry[]) => {
    setStored(next)
    writeLocal(next)
  }, [])

  // Home joins the list once, first; a full legacy list gives up its least recently used folder for it.
  useEffect(() => {
    let alive = true
    void localHomePath().then((path) => {
      if (!alive) return
      const list = readLocal()
      setHome(path)
      save(path ? placeHome(list, path, savedDirectory(), samePath) : list)
    })
    return () => {
      alive = false
    }
  }, [save])

  // The engine's folder is always a workspace, while there is room for it.
  const list = useMemo(() => {
    if (!stored || !directory || stored.some((w) => samePath(w.path, directory)) || stored.length >= MAX_WORKSPACES) return stored
    return [...stored, { path: directory, color: nextColor(stored.map((w) => w.color)) }]
  }, [stored, directory])

  useEffect(() => {
    if (list && list !== stored) writeLocal(list)
  }, [list, stored])

  // No room for the engine's folder: switch to the first workspace (Home) instead.
  useEffect(() => {
    if (list && directory && list.length && !list.some((w) => samePath(w.path, directory))) setDirectory(list[0].path)
  }, [list, directory, setDirectory])

  const active = list?.find((w) => directory && samePath(w.path, directory)) ?? null
  const paths = list?.map((w) => w.path).join("\n") ?? ""

  // Chats of the other workspaces. The engine groups non-git folders into one project, so filter by folder.
  useEffect(() => {
    if (!paths || !directory) return
    let alive = true
    const targets = paths.split("\n").filter((p) => !samePath(p, directory))
    void Promise.all(
      targets.map(async (p) => {
        const res = await oc(p, connection)
          .session.list()
          .catch(() => null)
        return (res?.data ?? []).filter((s) => !s.parentID && samePath(s.directory, p)).map((s) => ({ id: s.id, title: s.title, workspaceId: p, updated: s.time.updated ?? s.time.created }))
      }),
    ).then((r) => alive && setOthers(r.flat()))
    return () => {
      alive = false
    }
  }, [paths, directory, connection, tick])

  const value = useMemo<Ctx>(() => {
    const isHome = (p: string) => !!home && samePath(p, home)
    const workspaces = list?.map((w) => ({ id: w.path, name: isHome(w.path) ? "Home" : baseName(w.path), color: w.color, detail: w.path, home: isHome(w.path) })) ?? null
    // Remember when each folder was last used: a full list makes room by dropping the stalest.
    const pick = (path: string) => {
      setDirectory(path)
      if (list) save(list.map((w) => (samePath(w.path, path) ? { ...w, used: Date.now() } : w)))
    }
    return {
      mode: "local",
      workspaces,
      activeId: active?.path ?? null,
      chats: others.filter((c) => !active || c.workspaceId !== active.path),
      full: (list?.length ?? 0) >= MAX_WORKSPACES,
      user: null,
      homeId: workspaces?.find((w) => w.home)?.id ?? null,
      select: pick,
      open: (id) => {
        pick(id)
        router.push("/")
      },
      chatHref: (c) => `/s/${c.id}`,
      newChatHref: "/",
      add: async (input) => {
        if (!("path" in input) || !list) return "Choose a folder"
        if (!list.some((w) => samePath(w.path, input.path))) {
          if (list.length >= MAX_WORKSPACES) return LIMIT_MESSAGE
          save([...list, { path: input.path, color: nextColor(list.map((w) => w.color)), used: Date.now() }])
          setDirectory(input.path)
        } else pick(input.path)
        router.push("/")
        return null
      },
      remove: async (id) => {
        if (list && !isHome(id)) save(list.filter((w) => w.path !== id))
      },
    }
  }, [list, home, active, others, setDirectory, router, save])

  return <WorkspacesContext.Provider value={value}>{children}</WorkspacesContext.Provider>
}

// ---------------------------------------------------------------- cloud

type ApiWorkspace = { id: string; name: string; color: number; repoUrl: string | null; home: boolean }

export function CloudWorkspacesProvider({ user, children }: { user: CloudUser | null; children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const activeId = pathname.match(/^\/w\/([^/]+)/)?.[1] ?? null
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[] | null>(null)
  const [chats, setChats] = useState<ChatItem[]>([])
  const tick = useFocusTick()

  const load = useCallback(async () => {
    const [w, c] = await Promise.all([fetch("/api/workspaces", { cache: "no-store" }), fetch("/api/chats", { cache: "no-store" })])
    if (w.ok) {
      const list = (await w.json()).workspaces as ApiWorkspace[]
      setWorkspaces(list.map((x) => ({ id: x.id, name: x.name, color: x.color, home: x.home, detail: x.home ? "Your files, always here" : x.repoUrl ? x.repoUrl.replace(/^https:\/\//, "").replace(/\.git$/, "") : "empty workspace" })))
    }
    if (c.ok) setChats((await c.json()).chats as ChatItem[])
  }, [])

  useEffect(() => {
    if (!user) return
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [user, load, activeId, tick])

  const homeId = workspaces?.find((w) => w.home)?.id ?? null

  // Start Home's sandbox as soon as the app loads, so the first message rarely waits. Shared with WorkspaceView (src/lib/home.ts).
  // Skipped while another workspace is open: that one is what the user is waiting for.
  const elsewhere = !!activeId && activeId !== homeId
  useEffect(() => {
    if (homeId && !elsewhere && document.visibilityState === "visible") prewarmSandbox(homeId)
  }, [homeId, elsewhere])

  const value = useMemo<Ctx>(
    () => ({
      mode: "cloud",
      workspaces,
      activeId,
      chats,
      full: (workspaces?.length ?? 0) >= MAX_WORKSPACES,
      user,
      homeId,
      select: () => {},
      open: (id) => router.push(`/w/${id}`),
      chatHref: (c) => `/w/${c.workspaceId}/s/${c.id}`,
      newChatHref: activeId ? `/w/${activeId}` : homeId ? `/w/${homeId}` : "/",
      add: async (input) => {
        if ("path" in input) return "Folders are not available in the hosted version"
        const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok || !j.workspace) return j.error ?? "Could not create workspace"
        await load()
        router.push(`/w/${j.workspace.id}`)
        return null
      },
      remove: async (id) => {
        await fetch(`/api/workspaces/${id}`, { method: "DELETE" })
        await load()
      },
    }),
    [workspaces, activeId, chats, user, homeId, router, load],
  )

  return <WorkspacesContext.Provider value={value}>{children}</WorkspacesContext.Provider>
}
