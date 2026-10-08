"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react"
import posthog from "posthog-js"
import { clog, installClientLogging } from "./clientlog"
import { localHomePath } from "./home"
import { useKeyTiers } from "./use-key-tiers"
import { oc, ocRaw, type Connection, type Message, type Model, type Part, type Provider, type Session, type SessionStatus } from "./oc"

/**
 * Client-side mirror of the engine for the current workspace directory.
 * Loads sessions and messages over the proxy, then keeps them current from
 * the OpenCode event stream.
 */

export type MessageEntry = { info: Message; parts: Part[] }
/** `readSeq`: the stream sequence (State.stamps) the last messages read applied was sent at. */
export type SessionMessages = { order: string[]; byId: Record<string, MessageEntry>; loaded: boolean; readSeq: number }

/**
 * How this page holds a streaming text or reasoning part's text:
 * - "live": watched from its first character over the open stream, so its text is whole so far and grows from deltas.
 * - "frozen": was live, then the stream dropped. The text it has is a true beginning (the page saw it from the first
 *   character) but deltas sent during the drop are lost, so it stops growing and waits for the part's final update.
 */
export type PartStream = "live" | "frozen"

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
  /**
   * Text and reasoning parts this page has watched from their first character (their opening
   * message.part.updated came over the open event stream), keyed by part id. Only "live" ones grow from
   * message.part.delta events: the engine stores a streaming part empty and replays nothing, so a
   * part loaded mid-stream would show its tail without its beginning. The UI shows a "Writing"
   * indicator for those until their final message.part.updated. A dropped stream freezes the live
   * ones (PartStream): their text stays on screen, with the indicator under it.
   */
  live: Record<string, PartStream>
  /**
   * The sequence number of the last stream event that touched each message (message.updated) or part (its update or
   * deltas), by id. Every event the stream delivers gets the next number. A messages read carries the number current
   * when it was sent: whatever was touched after that may be newer than what the engine answered, so the read never
   * overwrites it (and never drops a message or part that started after it).
   */
  stamps: Record<string, number>
  /** Messages and parts the stream removed, with the event's sequence number: a read sent before that can't bring them back. */
  removed: Record<string, number>
}

/** A text or reasoning part that is still streaming: started, not ended (OpenCode sets time.end when it ends). */
export function isOpenPart(p: Part): boolean {
  return (p.type === "text" || p.type === "reasoning") && !!p.time && p.time.end === undefined
}

/** One part's text that arrived as message.part.delta events since the last store update, joined. `seq`: the last one's sequence number. */
type Delta = { sessionID: string; messageID: string; partID: string; field: string; text: string; seq: number }

/** What changed over the event stream while a state fetch was in flight, so the fetched snapshot never undoes it. */
type Touched = { status: Set<string>; permissions: Map<string, "asked" | "done">; questions: Map<string, "asked" | "done"> }

type Action =
  | { type: "connected"; value: boolean }
  | { type: "directory"; directory: string; defaultDirectory?: string }
  | { type: "projects"; projects: Project[] }
  | { type: "sessions"; sessions: Session[] }
  | { type: "session"; session: Session }
  | { type: "session.deleted"; id: string }
  // `seq`: for a read, the stream sequence number when it was sent; for a stream event, its own number.
  | { type: "messages"; sessionID: string; entries: MessageEntry[]; seq: number }
  | { type: "message"; info: Message; seq: number }
  | { type: "message.removed"; sessionID: string; messageID: string; seq: number }
  | { type: "part"; part: Part; seq: number }
  | { type: "deltas"; items: Delta[] }
  | { type: "part.removed"; sessionID: string; messageID: string; partID: string; seq: number }
  | { type: "snapshot"; status?: Record<string, SessionStatus>; permissions?: PermissionReq[]; questions?: QuestionReq[]; touched: Touched }
  | { type: "status"; sessionID: string; status: SessionStatus }
  | { type: "error"; sessionID: string; error?: string }
  | { type: "permission"; req: PermissionReq }
  | { type: "permission.done"; id: string }
  | { type: "question"; req: QuestionReq }
  | { type: "question.done"; id: string }
  | { type: "providers"; providers: Provider[]; defaults: Record<string, string> }
  | { type: "model"; model: ModelRef }

const empty: SessionMessages = { order: [], byId: {}, loaded: false, readSeq: -1 }

/** The sentence inside an engine error body ({ name, data: { message } }), a plain { error } or an Error. */
export function engineError(e: unknown): string {
  if (e instanceof Error) return e.message
  const o = (e ?? {}) as { data?: { message?: string }; name?: string; error?: string; message?: string }
  return o.data?.message ?? o.error ?? o.message ?? o.name ?? "The engine refused the request"
}

/** A copy of `rec` with `ids` set to `seq`. */
function stamp(rec: Record<string, number>, ids: string[], seq: number): Record<string, number> {
  const out = { ...rec }
  for (const id of ids) out[id] = Math.max(out[id] ?? -1, seq)
  return out
}

/**
 * A message as a read sent at stream sequence `seq` returned it, merged with the page's copy (`mine`). The read
 * wins, except for:
 * - its info or a part the stream touched after the read was sent (the read may predate that event);
 * - a streaming part this page has the text of (live or frozen): the engine stores a streaming part empty until it ends;
 * - parts that started after the read was sent (the read can't know them) and parts the stream removed since.
 */
function mergeRead(loaded: MessageEntry, mine: MessageEntry | undefined, s: State, seq: number): MessageEntry {
  const newer = (id: string) => (s.stamps[id] ?? -1) > seq
  const parts: Part[] = []
  for (const p of loaded.parts) {
    if ((s.removed[p.id] ?? -1) > seq) continue
    const own = mine?.parts.find((x) => x.id === p.id)
    parts.push(own && (newer(p.id) || (s.live[p.id] && isOpenPart(p))) ? own : p)
  }
  if (mine) for (const p of mine.parts) if (newer(p.id) && !parts.some((x) => x.id === p.id)) parts.push(p)
  return { info: mine && newer(loaded.info.id) ? mine.info : loaded.info, parts }
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "connected": {
      if (a.value) return { ...s, connected: true }
      // A dropped stream loses the deltas sent meanwhile, so no open part grows any more. The text a live part has is
      // still its true beginning (this page saw it from the first character): it stays, frozen, until the final update.
      const live: Record<string, PartStream> = {}
      for (const id in s.live) live[id] = "frozen"
      return { ...s, connected: false, live }
    }
    case "directory":
      // The same folder again (boot runs twice in development; a workspace list re-picks the open one) keeps what is
      // loaded: wiping it here left a chat on its skeleton when the wipe landed after its messages arrived.
      if (a.directory === s.directory) return { ...s, defaultDirectory: a.defaultDirectory ?? s.defaultDirectory }
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
        live: {},
        stamps: {},
        removed: {},
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
      // Its messages go too: child sessions (a repair's, a subagent's) would otherwise stay in memory for good.
      if (!(a.id in s.messages)) return { ...s, sessions }
      const messages = { ...s.messages }
      delete messages[a.id]
      return { ...s, sessions, messages }
    }
    case "messages": {
      const prev = s.messages[a.sessionID]
      // Reads can land out of order (a chat opened again while a reconnect re-reads it): an older one says nothing new.
      if (prev && a.seq < prev.readSeq) return s
      const byId: Record<string, MessageEntry> = {}
      const order: string[] = []
      for (const e of a.entries) {
        if ((s.removed[e.info.id] ?? -1) > a.seq) continue
        byId[e.info.id] = mergeRead(e, prev?.byId[e.info.id], s, a.seq)
        order.push(e.info.id)
      }
      // A message that started after the read was sent (a reply, or a new step with only tool calls): the read can't know it yet.
      if (prev) {
        const newer = (id: string) => (s.stamps[id] ?? -1) > a.seq
        for (const id of prev.order) {
          const mine = prev.byId[id]
          if (!byId[id] && mine && (newer(id) || mine.parts.some((p) => newer(p.id)))) {
            byId[id] = mine
            order.push(id)
          }
        }
      }
      return { ...s, messages: { ...s.messages, [a.sessionID]: { order, byId, loaded: true, readSeq: a.seq } } }
    }
    case "message": {
      const sm = s.messages[a.info.sessionID] ?? empty
      const existing = sm.byId[a.info.id]
      const byId = { ...sm.byId, [a.info.id]: { info: a.info, parts: existing?.parts ?? [] } }
      const order = existing ? sm.order : [...sm.order, a.info.id]
      return { ...s, stamps: stamp(s.stamps, [a.info.id], a.seq), messages: { ...s.messages, [a.info.sessionID]: { ...sm, order, byId } } }
    }
    case "message.removed": {
      const removed = stamp(s.removed, [a.messageID], a.seq)
      const sm = s.messages[a.sessionID]
      if (!sm) return { ...s, removed }
      const byId = { ...sm.byId }
      delete byId[a.messageID]
      return { ...s, removed, messages: { ...s.messages, [a.sessionID]: { ...sm, byId, order: sm.order.filter((id) => id !== a.messageID) } } }
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
      // An update over the stream carries the part's whole text so far (the engine writes a streaming part when it
      // starts and when it ends), so from here on its deltas extend a complete beginning. The final one ends that.
      let live = s.live
      if (isOpenPart(a.part)) {
        if (live[a.part.id] !== "live") live = { ...live, [a.part.id]: "live" }
      } else if (live[a.part.id]) {
        live = { ...live }
        delete live[a.part.id]
      }
      return { ...s, live, stamps: stamp(s.stamps, [a.part.id], a.seq), messages: { ...s.messages, [a.part.sessionID]: { ...sm, order, byId: { ...sm.byId, [a.part.messageID]: { info, parts } } } } }
    }
    case "deltas": {
      let messages = s.messages
      let stamps = s.stamps
      for (const d of a.items) {
        // Only a part watched from its start grows: the tail of a part joined mid-stream would read as the whole reply.
        if (s.live[d.partID] !== "live") continue
        const sm = messages[d.sessionID]
        const entry = sm?.byId[d.messageID]
        const i = entry ? entry.parts.findIndex((p) => p.id === d.partID) : -1
        if (!sm || !entry || i < 0) continue
        const part = entry.parts[i] as unknown as Record<string, unknown>
        const cur = part[d.field]
        if (cur !== undefined && typeof cur !== "string") continue
        const parts = [...entry.parts]
        parts[i] = { ...part, [d.field]: (cur ?? "") + d.text } as unknown as Part
        messages = { ...messages, [d.sessionID]: { ...sm, byId: { ...sm.byId, [d.messageID]: { ...entry, parts } } } }
        stamps = stamp(stamps, [d.partID], d.seq)
      }
      return messages === s.messages ? s : { ...s, messages, stamps }
    }
    case "part.removed": {
      const removed = stamp(s.removed, [a.partID], a.seq)
      const sm = s.messages[a.sessionID]
      const entry = sm?.byId[a.messageID]
      if (!sm || !entry) return { ...s, removed }
      return { ...s, removed, messages: { ...s.messages, [a.sessionID]: { ...sm, byId: { ...sm.byId, [a.messageID]: { ...entry, parts: entry.parts.filter((p) => p.id !== a.partID) } } } } }
    }
    case "snapshot": {
      // The engine's view on (re)connect, except where the stream already said something newer.
      const t = a.touched
      let status = s.status
      if (a.status) {
        status = { ...a.status }
        for (const id of t.status) {
          if (s.status[id]) status[id] = s.status[id]
          else delete status[id]
        }
      }
      const merge = <T extends { id: string }>(cur: T[], fetched: T[] | undefined, seen: Map<string, "asked" | "done">) =>
        fetched ? [...fetched.filter((x) => seen.get(x.id) !== "done"), ...cur.filter((x) => seen.get(x.id) === "asked" && !fetched.some((f) => f.id === x.id))] : cur
      return { ...s, status, permissions: merge(s.permissions, a.permissions, t.permissions), questions: merge(s.questions, a.questions, t.questions) }
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
  live: {},
  stamps: {},
  removed: {},
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
  /** True when at least one provider key is saved or connected (not just the built-in free models). */
  hasKeys: boolean
  /** hasKeys is settled (saved keys loaded or the engine reports one), so a "no keys" hint never flashes. */
  keysKnown: boolean
  /** Booted with a workspace directory. createSession and send wait for this, so a message typed early is kept, not lost. */
  ready: boolean
  /** Called (often, in bursts) when the agent may have changed workspace files. Returns an unsubscribe. */
  onFilesChanged(cb: () => void): () => void
}

const EngineContext = createContext<Ctx | null>(null)

const MODEL_KEY = "syrup.model"
const MODEL_KEY_CLOUD = "syrup.model.cloud"
const DIR_KEY = "syrup.directory"

// Raw event payloads we care about. Typed loosely: the v1 SDK types lag the server.
type RawEvent = { type: string; properties: Record<string, unknown> }

/** A pending permission as permission.asked and GET /permission carry it (OpenCode 1.18). */
function permissionOf(p: Record<string, unknown>): PermissionReq {
  return { id: p.id as string, sessionID: p.sessionID as string, title: p.permission as string, patterns: (p.patterns as string[]) ?? [], metadata: (p.metadata as Record<string, unknown>) ?? {} }
}

/** A pending question as question.asked and GET /question carry it. */
function questionOf(p: Record<string, unknown>): QuestionReq {
  return { id: p.id as string, sessionID: p.sessionID as string, questions: (p.questions as QuestionInfo[]) ?? [] }
}

export type EngineConnection = Connection & { directory: string }

/** `remote`: the engine lives in a cloud sandbox; until `connection` arrives, nothing is fetched and sends wait. */
export function EngineProvider({ children, connection, remote }: { children: ReactNode; connection?: EngineConnection | null; remote?: boolean }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const loading = useRef(new Set<string>())
  // Every event the stream delivers gets the next number (State.stamps); a messages read carries the number current when it is sent.
  const seq = useRef(0)
  const dir = state.directory
  // A new sandbox session (different URL or rotated password) must rebuild clients and reconnect the stream.
  const connKey = connection ? `${connection.baseUrl}|${connection.headers.authorization ?? ""}` : ""
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const conn = useMemo<Connection | null>(() => (connection ? { baseUrl: connection.baseUrl, headers: connection.headers } : null), [connKey])
  const fixedDirectory = connection?.directory ?? null
  const waiting = !!remote && !conn
  const modelKey = remote || conn ? MODEL_KEY_CLOUD : MODEL_KEY

  // Boot: engine default directory, saved workspace (Home on first run), providers, saved model.
  useEffect(() => {
    installClientLogging()
    if (waiting) return
    void (async () => {
      const t0 = Date.now()
      const [pathRes, prov, projRes, home] = await Promise.all([oc(undefined, conn).path.get(), oc(undefined, conn).config.providers(), oc(undefined, conn).project.list(), fixedDirectory ? null : localHomePath()])
      clog("boot.loaded", { ms: Date.now() - t0, providers: prov.data?.providers.map((p) => `${p.id}(${Object.keys(p.models).length})`), defaultDirectory: pathRes.data?.directory, projects: projRes.data?.length })
      const defaultDirectory = pathRes.data?.directory ?? ""
      let saved = ""
      if (!fixedDirectory) {
        try {
          saved = localStorage.getItem(DIR_KEY) ?? ""
        } catch {}
      }
      dispatch({ type: "directory", directory: fixedDirectory ?? (saved || home || defaultDirectory), defaultDirectory })
      if (projRes.data) dispatch({ type: "projects", projects: projRes.data as Project[] })
      if (prov.data) dispatch({ type: "providers", providers: prov.data.providers, defaults: prov.data.default })
      let model: ModelRef | null = null
      try {
        const raw = localStorage.getItem(modelKey)
        if (raw) model = JSON.parse(raw)
      } catch {}
      // A remembered model only counts if the engine still offers it.
      if (model && prov.data && !prov.data.providers.some((p) => p.id === model!.providerID && model!.modelID in p.models)) model = null
      if (model) dispatch({ type: "model", model })
      else if (prov.data) {
        // Prefer the router; otherwise the first provider default.
        const d = prov.data.default
        // The router alias is always the best default when it exists: it uses the user's own keys with failover.
        const providerID = prov.data.providers.some((p) => p.id === "syrup") || "syrup" in d ? "syrup" : Object.keys(d)[0]
        if (providerID) dispatch({ type: "model", model: { providerID, modelID: providerID === "syrup" ? "auto" : d[providerID] } })
      }
    })()
  }, [conn, fixedDirectory, waiting, modelKey])

  // Sessions for the current workspace.
  useEffect(() => {
    if (!dir) return
    void oc(dir, conn)
      .session.list()
      .then((res) => res.data && dispatch({ type: "sessions", sessions: res.data }))
  }, [dir, conn])

  // Event stream for the current workspace. Reconnects on drop.
  const reconnects = useRef(0)
  const loadedSessions = useRef(new Set<string>())
  // A listener set, not state: file events come in bursts and only the Files panel cares.
  const fileListeners = useRef(new Set<() => void>())
  const onFilesChanged = useCallback((cb: () => void) => {
    fileListeners.current.add(cb)
    return () => void fileListeners.current.delete(cb)
  }, [])
  useEffect(() => {
    if (!dir) return
    const ctrl = new AbortController()
    reconnects.current = 0
    /** Missed events cannot be replayed; reload what the UI is showing. */
    async function resync() {
      const list = await oc(dir, conn).session.list()
      if (list.data) dispatch({ type: "sessions", sessions: list.data })
      for (const id of loadedSessions.current) {
        const at = seq.current
        const res = await oc(dir, conn).session.messages({ path: { id } })
        if (res.data) dispatch({ type: "messages", sessionID: id, entries: res.data, seq: at })
      }
    }

    // Deltas arrive every few milliseconds while a model writes: join them per part and update the store at most
    // once per animation frame (the timer covers a hidden tab, where frames stop).
    const pending = new Map<string, Delta>()
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    function flushDeltas() {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      frame = 0
      timer = undefined
      if (!pending.size) return
      const items = [...pending.values()]
      pending.clear()
      dispatch({ type: "deltas", items })
    }
    function queueDelta(d: Omit<Delta, "text"> & { delta: string }) {
      const key = `${d.partID}\u0000${d.field}`
      const cur = pending.get(key)
      if (cur) {
        cur.text += d.delta
        cur.seq = d.seq
      } else pending.set(key, { sessionID: d.sessionID, messageID: d.messageID, partID: d.partID, field: d.field, text: d.delta, seq: d.seq })
      if (timer === undefined) {
        frame = requestAnimationFrame(flushDeltas)
        timer = setTimeout(flushDeltas, 100)
      }
    }
    /** A part's own update is authoritative: deltas queued before it are already in its text. */
    function dropDeltas(partID: string) {
      for (const key of pending.keys()) if (key.startsWith(`${partID}\u0000`)) pending.delete(key)
    }

    // The stream replays nothing on connect, so ask the engine what is going on: which sessions are busy, and the
    // permissions and questions waiting for an answer. Events that land while the reads are in flight win.
    let restoring = 0
    let touched: Touched | null = null
    async function restore() {
      const gen = ++restoring
      touched = { status: new Set(), permissions: new Map(), questions: new Map() }
      const raw = ocRaw(conn)
      const read = async <T,>(path: string): Promise<T | undefined> => {
        try {
          const res = await fetch(`${raw.base}${path}?directory=${encodeURIComponent(dir)}`, { cache: "no-store", headers: raw.headers, signal: ctrl.signal })
          return res.ok ? ((await res.json()) as T) : undefined
        } catch {
          return undefined
        }
      }
      const [status, permissions, questions] = await Promise.all([
        read<Record<string, SessionStatus>>("/session/status"),
        read<Record<string, unknown>[]>("/permission"),
        read<Record<string, unknown>[]>("/question"),
      ])
      if (gen !== restoring || ctrl.signal.aborted || !touched) return
      const seen = touched
      touched = null
      dispatch({
        type: "snapshot",
        status: status && typeof status === "object" && !Array.isArray(status) ? status : undefined,
        permissions: Array.isArray(permissions) ? permissions.map(permissionOf) : undefined,
        questions: Array.isArray(questions) ? questions.map(questionOf) : undefined,
        touched: seen,
      })
      clog("sse.restored", { busy: status ? Object.keys(status).length : null, permissions: permissions?.length ?? null, questions: questions?.length ?? null }, { directory: dir })
    }

    void (async () => {
      let failures = 0
      while (!ctrl.signal.aborted) {
        try {
          const raw = ocRaw(conn)
          const res = await fetch(`${raw.base}/event?directory=${encodeURIComponent(dir)}`, { signal: ctrl.signal, cache: "no-store", headers: raw.headers })
          if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
          const wasDown = failures > 0 || reconnects.current > 0
          reconnects.current++
          failures = 0
          dispatch({ type: "connected", value: true })
          void restore()
          if (wasDown) void resync()
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
        // Deltas still queued belong to parts that are no longer whole: the drop lost what came after them.
        pending.clear()
        touched = null
        restoring++
        dispatch({ type: "connected", value: false })
        await new Promise((r) => setTimeout(r, Math.min(1500 * Math.max(1, failures), 8000)))
      }
    })()

    function handle(ev: RawEvent) {
      const p = ev.properties
      const n = ++seq.current
      if (ev.type === "file.edited" || ev.type === "file.watcher.updated" || ev.type === "session.idle" || (ev.type === "message.part.updated" && (p.part as Part | undefined)?.type === "patch")) {
        for (const cb of fileListeners.current) cb()
      }
      switch (ev.type) {
        case "session.created":
        case "session.updated":
          dispatch({ type: "session", session: p.info as Session })
          break
        case "session.deleted":
          dispatch({ type: "session.deleted", id: (p.info as Session).id })
          break
        case "message.updated":
          dispatch({ type: "message", info: p.info as Message, seq: n })
          break
        case "message.removed":
          dispatch({ type: "message.removed", sessionID: p.sessionID as string, messageID: p.messageID as string, seq: n })
          break
        case "message.part.updated": {
          const part = p.part as Part
          dropDeltas(part.id)
          dispatch({ type: "part", part, seq: n })
          break
        }
        case "message.part.delta":
          // OpenCode 1.18 streams a part's text only this way; the part's final update carries the whole text.
          if (typeof p.delta === "string" && p.delta && typeof p.partID === "string" && typeof p.field === "string") {
            queueDelta({ sessionID: p.sessionID as string, messageID: p.messageID as string, partID: p.partID, field: p.field, delta: p.delta, seq: n })
          }
          break
        case "message.part.removed":
          dropDeltas(p.partID as string)
          dispatch({ type: "part.removed", sessionID: p.sessionID as string, messageID: p.messageID as string, partID: p.partID as string, seq: n })
          break
        case "session.status":
          touched?.status.add(p.sessionID as string)
          dispatch({ type: "status", sessionID: p.sessionID as string, status: p.status as SessionStatus })
          break
        case "session.idle":
          touched?.status.add(p.sessionID as string)
          dispatch({ type: "status", sessionID: p.sessionID as string, status: { type: "idle" } })
          break
        case "session.error": {
          const e = p.error as { data?: { message?: string }; name?: string } | undefined
          dispatch({ type: "error", sessionID: p.sessionID as string, error: e?.data?.message ?? e?.name ?? "Unknown error" })
          clog("session.error.shown", { error: e }, { level: "error", sessionId: p.sessionID as string })
          break
        }
        case "permission.updated": // v1 shape
          touched?.permissions.set(p.id as string, "asked")
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
          touched?.permissions.set(p.id as string, "asked")
          dispatch({ type: "permission", req: permissionOf(p) })
          break
        case "permission.replied": {
          // 1.18 names the request `requestID`; older engines used `permissionID`.
          const id = (p.requestID as string) ?? (p.permissionID as string) ?? (p.id as string)
          touched?.permissions.set(id, "done")
          dispatch({ type: "permission.done", id })
          break
        }
        case "question.asked":
          touched?.questions.set(p.id as string, "asked")
          dispatch({ type: "question", req: questionOf(p) })
          break
        case "question.replied":
        case "question.rejected": {
          const id = (p.requestID as string) ?? (p.id as string)
          touched?.questions.set(id, "done")
          dispatch({ type: "question.done", id })
          break
        }
      }
    }

    return () => {
      ctrl.abort()
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      pending.clear()
    }
  }, [dir, conn])

  const setDirectory = useCallback((next: string) => {
    const d = next.trim()
    if (!d || fixedDirectory) return
    try {
      localStorage.setItem(DIR_KEY, d)
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
      // Before boot knows the workspace a load would be wiped by the directory reset; callers re-run once dir is set.
      if (!dir) return
      const key = `${dir}\u0000${sessionID}`
      if (loading.current.has(key)) return
      loading.current.add(key)
      try {
        const at = seq.current
        const res = await oc(dir, conn).session.messages({ path: { id: sessionID } })
        // An empty or failed read still ends the loading state, so the chat never sits on a skeleton forever.
        dispatch({ type: "messages", sessionID, entries: res.data ?? [], seq: at })
        loadedSessions.current.add(sessionID)
      } finally {
        loading.current.delete(key)
      }
    },
    [dir, conn],
  )

  // Latest engine target for callbacks that waited for boot (their render-time closure predates it).
  const ready = !!state.directory
  const live = useRef<{ dir: string; conn: Connection | null; model: ModelRef | null }>({ dir: "", conn: null, model: null })
  const waiters = useRef<(() => void)[]>([])
  useEffect(() => {
    live.current = { dir: state.directory, conn, model: state.model }
    if (!ready) return
    const w = waiters.current
    waiters.current = []
    for (const resolve of w) resolve()
  }, [ready, state.directory, conn, state.model])
  const whenReady = useCallback(() => (live.current.dir ? Promise.resolve() : new Promise<void>((resolve) => waiters.current.push(resolve))), [])

  const createSession = useCallback(async () => {
    await whenReady()
    const { dir, conn } = live.current
    const res = await oc(dir, conn).session.create({ body: {} })
    if (!res.data) {
      clog("session.create.failed", { error: res.error }, { level: "error", directory: dir })
      throw new Error(engineError(res.error))
    }
    clog("session.created", { id: res.data.id }, { sessionId: res.data.id, directory: dir })
    dispatch({ type: "session", session: res.data })
    void oc(undefined, conn)
      .project.list()
      .then((r) => r.data && dispatch({ type: "projects", projects: r.data as Project[] }))
    return res.data
  }, [whenReady])

  const send = useCallback(
    async (sessionID: string, text: string, files: { name: string; mime: string; url: string }[] = []) => {
      await whenReady()
      const { dir, conn, model } = live.current
      dispatch({ type: "error", sessionID, error: undefined })
      const parts: ({ type: "text"; text: string } | { type: "file"; mime: string; filename: string; url: string })[] = []
      if (text) parts.push({ type: "text", text })
      for (const f of files) parts.push({ type: "file", mime: f.mime, filename: f.name, url: f.url })
      clog("prompt.sent", { model, chars: text.length, files: files.map((f) => ({ name: f.name, mime: f.mime, bytes: f.url.length })) }, { sessionId: sessionID, directory: dir })
      try {
        if (posthog.__loaded) posthog.capture("message_sent", { provider: model?.providerID, model: model?.modelID, chars_bucket: text.length < 200 ? "s" : text.length < 2000 ? "m" : "l", files: files.length, cloud: !!conn })
      } catch {}
      const res = await oc(dir, conn).session.promptAsync({
        path: { id: sessionID },
        body: { model: model ?? undefined, parts },
      })
      if (res.error) {
        clog("prompt.failed", { error: res.error }, { level: "error", sessionId: sessionID, directory: dir })
        // A refused prompt never produces a session.error event, so the chat would stay silent without this.
        dispatch({ type: "error", sessionID, error: engineError(res.error) })
      }
    },
    [whenReady],
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
      localStorage.setItem(modelKey, JSON.stringify(m))
    } catch {}
  }, [modelKey])

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

  // Keys saved in syrup count, not just what the engine sees: in the cloud keys go only to the router, never to the engine.
  const tiers = useKeyTiers()
  const engineHasKeys = useMemo(() => state.providers.some((p) => p.id !== "opencode" && p.id !== "syrup"), [state.providers])
  const hasKeys = engineHasKeys || (tiers?.size ?? 0) > 0
  const keysKnown = engineHasKeys || tiers !== null

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
    keysKnown,
    ready,
    onFilesChanged,
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
