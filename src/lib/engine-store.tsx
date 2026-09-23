"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react"
import { oc, type Message, type Model, type Part, type Provider, type Session, type SessionStatus } from "./oc"

/**
 * Client-side mirror of the engine. Loads sessions and messages over the
 * proxy, then keeps them current from the OpenCode event stream.
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

type State = {
  connected: boolean
  sessions: Record<string, Session>
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
    case "sessions": {
      const sessions = { ...s.sessions }
      for (const x of a.sessions) sessions[x.id] = x
      return { ...s, sessions }
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
  sessions: {},
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
  loadMessages(sessionID: string): Promise<void>
  createSession(): Promise<Session>
  send(sessionID: string, text: string): Promise<void>
  abort(sessionID: string): Promise<void>
  setModel(m: ModelRef): void
  replyPermission(req: PermissionReq, response: "once" | "always" | "reject"): Promise<void>
  replyQuestion(req: QuestionReq, answers: string[][]): Promise<void>
  rejectQuestion(req: QuestionReq): Promise<void>
  models: (Model & { free: boolean })[]
}

const EngineContext = createContext<Ctx | null>(null)

const MODEL_KEY = "syrup.model"

// Raw event payloads we care about. Typed loosely: the v1 SDK types lag the server.
type RawEvent = { type: string; properties: Record<string, unknown> }

export function EngineProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const loading = useRef(new Set<string>())

  // Initial load: sessions, providers, saved model.
  useEffect(() => {
    void (async () => {
      const [sess, prov] = await Promise.all([oc().session.list(), oc().config.providers()])
      if (sess.data) dispatch({ type: "sessions", sessions: sess.data })
      if (prov.data) dispatch({ type: "providers", providers: prov.data.providers, defaults: prov.data.default })
      let saved: ModelRef | null = null
      try {
        const raw = localStorage.getItem(MODEL_KEY)
        if (raw) saved = JSON.parse(raw)
      } catch {}
      if (saved) dispatch({ type: "model", model: saved })
      else if (prov.data) {
        const [providerID, modelID] = Object.entries(prov.data.default)[0] ?? []
        if (providerID && modelID) dispatch({ type: "model", model: { providerID, modelID } })
      }
    })()
  }, [])

  // Event stream. Reconnects on drop.
  useEffect(() => {
    const ctrl = new AbortController()
    void (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const res = await fetch("/api/oc/event", { signal: ctrl.signal, cache: "no-store" })
          if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
          dispatch({ type: "connected", value: true })
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
          console.warn("[syrup] event stream dropped", err)
        }
        dispatch({ type: "connected", value: false })
        await new Promise((r) => setTimeout(r, 1500))
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
  }, [])

  const loadMessages = useCallback(async (sessionID: string) => {
    if (loading.current.has(sessionID)) return
    loading.current.add(sessionID)
    try {
      const res = await oc().session.messages({ path: { id: sessionID } })
      if (res.data) dispatch({ type: "messages", sessionID, entries: res.data })
    } finally {
      loading.current.delete(sessionID)
    }
  }, [])

  const createSession = useCallback(async () => {
    const res = await oc().session.create({ body: {} })
    if (!res.data) throw new Error("could not create session")
    dispatch({ type: "session", session: res.data })
    return res.data
  }, [])

  const send = useCallback(
    async (sessionID: string, text: string) => {
      dispatch({ type: "error", sessionID, error: undefined })
      await oc().session.promptAsync({
        path: { id: sessionID },
        body: { model: state.model ?? undefined, parts: [{ type: "text", text }] },
      })
    },
    [state.model],
  )

  const abort = useCallback(async (sessionID: string) => {
    await oc().session.abort({ path: { id: sessionID } })
  }, [])

  const setModel = useCallback((m: ModelRef) => {
    dispatch({ type: "model", model: m })
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(m))
    } catch {}
  }, [])

  const replyPermission = useCallback(async (req: PermissionReq, response: "once" | "always" | "reject") => {
    dispatch({ type: "permission.done", id: req.id })
    await oc().postSessionIdPermissionsPermissionId({ path: { id: req.sessionID, permissionID: req.id }, body: { response } })
  }, [])

  const replyQuestion = useCallback(async (req: QuestionReq, answers: string[][]) => {
    dispatch({ type: "question.done", id: req.id })
    await fetch(`/api/oc/question/${req.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    })
  }, [])

  const rejectQuestion = useCallback(async (req: QuestionReq) => {
    dispatch({ type: "question.done", id: req.id })
    await fetch(`/api/oc/question/${req.id}/reject`, { method: "POST" })
  }, [])

  const models = useMemo(() => {
    const out: (Model & { free: boolean })[] = []
    for (const p of state.providers) {
      for (const m of Object.values(p.models)) {
        const c = m.cost
        out.push({ ...m, free: !c || (c.input === 0 && c.output === 0) })
      }
    }
    return out.sort((a, b) => Number(b.free) - Number(a.free) || a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name))
  }, [state.providers])

  const value: Ctx = {
    ...state,
    loadMessages,
    createSession,
    send,
    abort,
    setModel,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    models,
  }
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
}

export function useEngine(): Ctx {
  const ctx = useContext(EngineContext)
  if (!ctx) throw new Error("useEngine outside EngineProvider")
  return ctx
}
