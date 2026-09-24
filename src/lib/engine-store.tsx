"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react"
import { clog, installClientLogging } from "./clientlog"
import { oc, ocRaw, type Connection, type Message, type Model, type Part, type Provider, type Session, type SessionStatus } from "./oc"

/**
 * Client-side mirror of the engine for the current workspace directory.
 * Loads sessions and messages over the proxy, then keeps them current from
 * the OpenCode event stream.
 */

export type MessageEntry = { info: Message; parts: Part[] }
export type SessionMessages = { order: string[]; byId: Record<string, MessageEntry>; loaded: boolean }

export type PermissionReq = {
  id: string
  sessionID: string
  title: string
  patterns: string[]
  metadata: Record<string, unknown>
}

export type QuestionInfo = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}
export type QuestionReq = { id: string; sessionID: string; questions: QuestionInfo[] }

export type ModelRef = { providerID: string; modelID: string }
export type Project = { id: string; worktree: string; name?: string; time: { created: number; updated?: number } }

type State = {
  connected: boolean
  /** Absolute path the agent works in. Empty until known. */
  directory: string
  defaultDirectory: string
  projects: Project[]
  sessions: Record<string, Session>
  sessionsLoaded: boolean
  messages: Record<string, SessionMessages>
  status: Record<string, SessionStatus>
  errors: Record<string, string | undefined>
  permissions: PermissionReq[]
  questions: QuestionReq[]
  providers: Provider[]
  defaults: Record<string, string>
  model: ModelRef | null
}

type Action =
  | { type: "connected"; value: boolean }
  | { type: "directory"; directory: string; defaultDirectory?: string }
  | { type: "projects"; projects: Project[] }
  | { type: "sessions"; sessions: Session[] }
  | { type: "session"; session: Session }
  | { type: "session.deleted"; id: string }
  | { type: "messages"; sessionID: string; entries: MessageEntry[] }
  | { type: "message"; info: Message }
  | { type: "message.removed"; sessionID: string; messageID: string }
  | { type: "part"; part: Part }
  | { type: "part.removed"; sessionID: string; messageID: string; partID: string }
  | { type: "status"; sessionID: string; status: SessionStatus }
  | { type: "error"; sessionID: string; error?: string }
  | { type: "permission"; req: PermissionReq }
  | { type: "permission.done"; id: string }
  | { type: "question"; req: QuestionReq }
  | { type: "question.done"; id: string }
  | { type: "providers"; providers: Provider[]; defaults: Record<string, string> }
  | { type: "model"; model: ModelRef }

const empty: SessionMessages = { order: [], byId: {}, loaded: false }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "connected":
      return { ...s, connected: a.value }
    case "directory":
      // Switching workspace drops per-workspace state; providers and model stay.
      return {
        ...s,
        directory: a.directory,
        defaultDirectory: a.defaultDirectory ?? s.defaultDirectory,
        sessions: {},
        sessionsLoaded: false,
        messages: {},
        status: {},
        errors: {},
        permissions: [],
        questions: [],
      }
    case "projects":
      return { ...s, projects: a.projects }
    case "sessions": {
      const sessions: Record<string, Session> = {}
      for (const x of a.sessions) sessions[x.id] = x
      return { ...s, sessions, sessionsLoaded: true }
    }
    case "session":
      return { ...s, sessions: { ...s.sessions, [a.session.id]: a.session } }
    case "session.deleted": {
      const sessions = { ...s.sessions }
      delete sessions[a.id]
      return { ...s, sessions }
    }
    case "messages": {
      const byId: Record<string, MessageEntry> = {}
      const order: string[] = []
      for (const e of a.entries) {
        byId[e.info.id] = e
        order.push(e.info.id)
      }
      return { ...s, messages: { ...s.messages, [a.sessionID]: { order, byId, loaded: true } } }
    }
    case "message": {
      const sm = s.messages[a.info.sessionID] ?? empty
      const existing = sm.byId[a.info.id]
      const byId = { ...sm.byId, [a.info.id]: { info: a.info, parts: existing?.parts ?? [] } }
      const order = existing ? sm.order : [...sm.order, a.info.id]
      return { ...s, messages: { ...s.messages, [a.info.sessionID]: { ...sm, order, byId } } }
    }
    case "message.removed": {
      const sm = s.messages[a.sessionID]
      if (!sm) return s
      const byId = { ...sm.byId }
      delete byId[a.messageID]
      return { ...s, messages: { ...s.messages, [a.sessionID]: { ...sm, byId, order: sm.order.filter((id) => id !== a.messageID) } } }
    }
    case "part": {
      const sm = s.messages[a.part.sessionID] ?? empty
      const entry = sm.byId[a.part.messageID]
      // Part for a message we have not seen yet: create a placeholder so text streams in immediately.
      const info: Message = entry?.info ?? ({ id: a.part.messageID, sessionID: a.part.sessionID, role: "assistant", time: { created: Date.now() } } as unknown as Message)
      const parts = entry ? [...entry.parts] : []
      const i = parts.findIndex((p) => p.id === a.part.id)
      if (i >= 0) parts[i] = a.part
      else parts.push(a.part)
      const order = entry ? sm.order : [...sm.order, a.part.messageID]
      return { ...s, messages: { ...s.messages, [a.part.sessionID]: { ...sm, order, byId: { ...sm.byId, [a.part.messageID]: { info, parts } } } } }
    }
    case "part.removed": {
      const sm = s.messages[a.sessionID]
      const entry = sm?.byId[a.messageID]
      if (!sm || !entry) return s
      return { ...s, messages: { ...s.messages, [a.sessionID]: { ...sm, byId: { ...sm.byId, [a.messageID]: { ...entry, parts: entry.parts.filter((p) => p.id !== a.partID) } } } } }
    }
    case "status":
      return { ...s, status: { ...s.status, [a.sessionID]: a.status } }
    case "error":
      return { ...s, errors: { ...s.errors, [a.sessionID]: a.error } }
    case "permission":
      return s.permissions.some((p) => p.id === a.req.id) ? s : { ...s, permissions: [...s.permissions, a.req] }
    case "permission.done":
      return { ...s, permissions: s.permissions.filter((p) => p.id !== a.id) }
    case "question":
      return s.questions.some((q) => q.id === a.req.id) ? s : { ...s, questions: [...s.questions, a.req] }
    case "question.done":
      return { ...s, questions: s.questions.filter((q) => q.id !== a.id) }
    case "providers":
      return { ...s, providers: a.providers, defaults: a.defaults }
    case "model":
      return { ...s, model: a.model }
  }
}

const initial: State = {
  connected: false,
  directory: "",
  defaultDirectory: "",
  projects: [],
  sessions: {},
  sessionsLoaded: false,
  messages: {},
  status: {},
  errors: {},
  permissions: [],
  questions: [],
  providers: [],
  defaults: {},
  model: null,
}

type Ctx = State & {
  /** Cloud: the sandbox this provider talks to. Null in local mode (proxy). */
  connection: Connection | null
  setDirectory(dir: string): void
  refreshProjects(): Promise<void>
  loadMessages(sessionID: string): Promise<void>
  createSession(): Promise<Session>
  send(sessionID: string, text: string, files?: { name: string; mime: string; url: string }[]): Promise<void>
  abort(sessionID: string): Promise<void>
  renameSession(sessionID: string, title: string): Promise<void>
  deleteSession(sessionID: string): Promise<void>
  setModel(m: ModelRef): void
  refreshProviders(): Promise<void>
  replyPermission(req: PermissionReq, response: "once" | "always" | "reject"): Promise<void>
  replyQuestion(req: QuestionReq, answers: string[][]): Promise<void>
  rejectQuestion(req: QuestionReq): Promise<void>
  models: (Model & { free: boolean })[]
  /** True when at least one key-based provider is connected (not just the built-in free ones). */
  hasKeys: boolean
}

const EngineContext = createContext<Ctx | null>(null)

const MODEL_KEY = "syrup.model"
const DIR_KEY = "syrup.directory"
const RECENT_KEY = "syrup.recentDirs"

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : []
  } catch {
    return []
  }
}

// Raw event payloads we care about. Typed loosely: the v1 SDK types lag the server.
type RawEvent = { type: string; properties: Record<string, unknown> }

export type EngineConnection = Connection & { directory: string }

export function EngineProvider({ children, connection }: { children: ReactNode; connection?: EngineConnection | null }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const loading = useRef(new Set<string>())
  const dir = state.directory
  // A new sandbox session (different URL or rotated password) must rebuild clients and reconnect the stream.
  const connKey = connection ? `${connection.baseUrl}|${connection.headers.authorization ?? ""}` : ""
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const conn = useMemo<Connection | null>(() => (connection ? { baseUrl: connection.baseUrl, headers: connection.headers } : null), [connKey])
  const fixedDirectory = connection?.directory ?? null

  // Boot: engine default directory, saved workspace, providers, saved model.
  useEffect(() => {
    installClientLogging()
    void (async () => {
      const t0 = Date.now()
      const [pathRes, prov, projRes] = await Promise.all([oc(undefined, conn).path.get(), oc(undefined, conn).config.providers(), oc(undefined, conn).project.list()])
      clog("boot.loaded", { ms: Date.now() - t0, providers: prov.data?.providers.map((p) => `${p.id}(${Object.keys(p.models).length})`), defaultDirectory: pathRes.data?.directory, projects: projRes.data?.length })
      const defaultDirectory = pathRes.data?.directory ?? ""
      let saved = ""
      if (!fixedDirectory) {
        try {
          saved = localStorage.getItem(DIR_KEY) ?? ""
        } catch {}
      }
      dispatch({ type: "directory", directory: fixedDirectory ?? (saved || defaultDirectory), defaultDirectory })
      if (projRes.data) dispatch({ type: "projects", projects: projRes.data as Project[] })
      if (prov.data) dispatch({ type: "providers", providers: prov.data.providers, defaults: prov.data.default })
      let model: ModelRef | null = null
      try {
        const raw = localStorage.getItem(MODEL_KEY)
        if (raw) model = JSON.parse(raw)
      } catch {}
      if (model) dispatch({ type: "model", model })
      else if (prov.data) {
        // Prefer the router; otherwise the first provider default.
        const d = prov.data.default
        const providerID = "syrup" in d ? "syrup" : Object.keys(d)[0]
        if (providerID) dispatch({ type: "model", model: { providerID, modelID: providerID === "syrup" ? "auto" : d[providerID] } })
      }
    })()
  }, [conn, fixedDirectory])

  // Sessions for the current workspace.
  useEffect(() => {
    if (!dir) return
    void oc(dir, conn)
      .session.list()
      .then((res) => res.data && dispatch({ type: "sessions", sessions: res.data }))
  }, [dir, conn])

  // Event stream for the current workspace. Reconnects on drop.
  useEffect(() => {
    if (!dir) return
    const ctrl = new AbortController()
    void (async () => {
      let failures = 0
      while (!ctrl.signal.aborted) {
        try {
          const raw = ocRaw(conn)
          const res = await fetch(`${raw.base}/event?directory=${encodeURIComponent(dir)}`, { signal: ctrl.signal, cache: "no-store", headers: raw.headers })
          if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
          failures = 0
          dispatch({ type: "connected", value: true })
          clog("sse.connected", { directory: dir }, { directory: dir })
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ""
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let idx: number
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const data = chunk
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("\n")
              if (!data) continue
              try {
                handle(JSON.parse(data) as RawEvent)
              } catch {}
            }
          }
        } catch (err) {
          if (ctrl.signal.aborted) return
          // The engine restarts when keys or skills change; stay quiet for the first few misses.
          if (++failures > 3) console.warn("[syrup] event stream dropped", err)
          clog("sse.dropped", { failures, error: err instanceof Error ? err.message : String(err) }, { level: failures > 3 ? "warn" : "info", directory: dir })
        }
        dispatch({ type: "connected", value: false })
        await new Promise((r) => setTimeout(r, Math.min(1500 * Math.max(1, failures), 8000)))
      }
    })()

    function handle(ev: RawEvent) {
      const p = ev.properties
      switch (ev.type) {
        case "session.created":
        case "session.updated":
          dispatch({ type: "session", session: p.info as Session })
          break
        case "session.deleted":
          dispatch({ type: "session.deleted", id: (p.info as Session).id })
          break
        case "message.updated":
          dispatch({ type: "message", info: p.info as Message })
          break
        case "message.removed":
          dispatch({ type: "message.removed", sessionID: p.sessionID as string, messageID: p.messageID as string })
          break
        case "message.part.updated":
          dispatch({ type: "part", part: p.part as Part })
          break
        case "message.part.removed":
          dispatch({ type: "part.removed", sessionID: p.sessionID as string, messageID: p.messageID as string, partID: p.partID as string })
          break
        case "session.status":
          dispatch({ type: "status", sessionID: p.sessionID as string, status: p.status as SessionStatus })
          break
        case "session.idle":
          dispatch({ type: "status", sessionID: p.sessionID as string, status: { type: "idle" } })
          break
        case "session.error": {
          const e = p.error as { data?: { message?: string }; name?: string } | undefined
          dispatch({ type: "error", sessionID: p.sessionID as string, error: e?.data?.message ?? e?.name ?? "Unknown error" })
          clog("session.error.shown", { error: e }, { level: "error", sessionId: p.sessionID as string })
          break
        }
        case "permission.updated": // v1 shape
          dispatch({
            type: "permission",
            req: {
              id: p.id as string,
              sessionID: p.sessionID as string,
              title: (p.title as string) ?? (p.type as string),
              patterns: Array.isArray(p.pattern) ? (p.pattern as string[]) : p.pattern ? [p.pattern as string] : [],
              metadata: (p.metadata as Record<string, unknown>) ?? {},
            },
          })
          break
        case "permission.asked": // v2 shape
          dispatch({
            type: "permission",
            req: {
              id: p.id as string,
              sessionID: p.sessionID as string,
              title: p.permission as string,
              patterns: (p.patterns as string[]) ?? [],
              metadata: (p.metadata as Record<string, unknown>) ?? {},
            },
          })
          break
        case "permission.replied":
          dispatch({ type: "permission.done", id: (p.permissionID as string) ?? (p.id as string) })
          break
        case "question.asked":
          dispatch({ type: "question", req: { id: p.id as string, sessionID: p.sessionID as string, questions: p.questions as QuestionInfo[] } })
          break
        case "question.replied":
        case "question.rejected":
          dispatch({ type: "question.done", id: (p.requestID as string) ?? (p.id as string) })
          break
      }
    }

    return () => ctrl.abort()
  }, [dir, conn])

  const setDirectory = useCallback((next: string) => {
    const d = next.trim()
    if (!d || fixedDirectory) return
    try {
      localStorage.setItem(DIR_KEY, d)
      // Recent workspaces are tracked here: the engine groups non-git folders into one project.
      const recent = readRecent().filter((x) => x !== d)
      localStorage.setItem(RECENT_KEY, JSON.stringify([d, ...recent].slice(0, 10)))
    } catch {}
    clog("workspace.changed", { directory: d }, { directory: d })
    dispatch({ type: "directory", directory: d })
  }, [fixedDirectory])

  const refreshProjects = useCallback(async () => {
    const res = await oc(undefined, conn).project.list()
    if (res.data) dispatch({ type: "projects", projects: res.data as Project[] })
  }, [conn])

  const loadMessages = useCallback(
    async (sessionID: string) => {
      if (loading.current.has(sessionID)) return
      loading.current.add(sessionID)
      try {
        const res = await oc(dir, conn).session.messages({ path: { id: sessionID } })
        if (res.data) dispatch({ type: "messages", sessionID, entries: res.data })
      } finally {
        loading.current.delete(sessionID)
      }
    },
    [dir, conn],
  )

  const createSession = useCallback(async () => {
    const res = await oc(dir, conn).session.create({ body: {} })
    if (!res.data) {
      clog("session.create.failed", { error: res.error }, { level: "error", directory: dir })
      throw new Error("could not create session")
    }
    clog("session.created", { id: res.data.id }, { sessionId: res.data.id, directory: dir })
    dispatch({ type: "session", session: res.data })
    void refreshProjects()
    return res.data
  }, [dir, conn, refreshProjects])

  const send = useCallback(
    async (sessionID: string, text: string, files: { name: string; mime: string; url: string }[] = []) => {
      dispatch({ type: "error", sessionID, error: undefined })
      const parts: ({ type: "text"; text: string } | { type: "file"; mime: string; filename: string; url: string })[] = []
      if (text) parts.push({ type: "text", text })
      for (const f of files) parts.push({ type: "file", mime: f.mime, filename: f.name, url: f.url })
      clog("prompt.sent", { model: state.model, chars: text.length, files: files.map((f) => ({ name: f.name, mime: f.mime, bytes: f.url.length })) }, { sessionId: sessionID, directory: dir })
      const res = await oc(dir, conn).session.promptAsync({
        path: { id: sessionID },
        body: { model: state.model ?? undefined, parts },
      })
      if (res.error) clog("prompt.failed", { error: res.error }, { level: "error", sessionId: sessionID, directory: dir })
    },
    [dir, conn, state.model],
  )

  const abort = useCallback(
    async (sessionID: string) => {
      clog("prompt.aborted", {}, { sessionId: sessionID, directory: dir })
      await oc(dir, conn).session.abort({ path: { id: sessionID } })
    },
    [dir, conn],
  )

  const renameSession = useCallback(
    async (sessionID: string, title: string) => {
      const res = await oc(dir, conn).session.update({ path: { id: sessionID }, body: { title } })
      if (res.data) dispatch({ type: "session", session: res.data })
    },
    [dir, conn],
  )

  const deleteSession = useCallback(
    async (sessionID: string) => {
      await oc(dir, conn).session.delete({ path: { id: sessionID } })
      dispatch({ type: "session.deleted", id: sessionID })
    },
    [dir, conn],
  )

  const refreshProviders = useCallback(async () => {
    const prov = await oc(undefined, conn).config.providers()
    if (prov.data) dispatch({ type: "providers", providers: prov.data.providers, defaults: prov.data.default })
  }, [conn])

  const setModel = useCallback((m: ModelRef) => {
    clog("model.changed", m)
    dispatch({ type: "model", model: m })
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(m))
    } catch {}
  }, [])

  const replyPermission = useCallback(
    async (req: PermissionReq, response: "once" | "always" | "reject") => {
      clog("permission.replied", { id: req.id, title: req.title, response }, { sessionId: req.sessionID, directory: dir })
      dispatch({ type: "permission.done", id: req.id })
      await oc(dir, conn).postSessionIdPermissionsPermissionId({ path: { id: req.sessionID, permissionID: req.id }, body: { response } })
    },
    [dir, conn],
  )

  const replyQuestion = useCallback(
    async (req: QuestionReq, answers: string[][]) => {
      clog("question.answered", { id: req.id, answers }, { sessionId: req.sessionID, directory: dir })
      dispatch({ type: "question.done", id: req.id })
      const raw = ocRaw(conn)
      await fetch(`${raw.base}/question/${req.id}/reply?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...raw.headers },
        body: JSON.stringify({ answers }),
      })
    },
    [dir, conn],
  )

  const rejectQuestion = useCallback(
    async (req: QuestionReq) => {
      dispatch({ type: "question.done", id: req.id })
      const raw = ocRaw(conn)
      await fetch(`${raw.base}/question/${req.id}/reject?directory=${encodeURIComponent(dir)}`, { method: "POST", headers: raw.headers })
    },
    [dir, conn],
  )

  const models = useMemo(() => {
    const out: (Model & { free: boolean })[] = []
    for (const p of state.providers) {
      for (const m of Object.values(p.models)) {
        const c = m.cost
        out.push({ ...m, free: !c || (c.input === 0 && c.output === 0) })
      }
    }
    // Router first, then free models, then by provider and name.
    return out.sort(
      (a, b) =>
        Number(b.providerID === "syrup") - Number(a.providerID === "syrup") ||
        Number(b.free) - Number(a.free) ||
        a.providerID.localeCompare(b.providerID) ||
        a.name.localeCompare(b.name),
    )
  }, [state.providers])

  const hasKeys = useMemo(() => state.providers.some((p) => p.id !== "opencode" && p.id !== "syrup"), [state.providers])

  const value: Ctx = {
    ...state,
    connection: conn,
    setDirectory,
    refreshProjects,
    loadMessages,
    createSession,
    send,
    abort,
    renameSession,
    deleteSession,
    setModel,
    refreshProviders,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    models,
    hasKeys,
  }
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
}

/** Null when no EngineProvider is mounted (cloud mode). */
export function useOptionalEngine(): Ctx | null {
  return useContext(EngineContext)
}

export function useEngine(): Ctx {
  const ctx = useContext(EngineContext)
  if (!ctx) throw new Error("useEngine outside EngineProvider")
  return ctx
}
