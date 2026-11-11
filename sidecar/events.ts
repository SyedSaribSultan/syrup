import type { Log } from "../src/server/shared/log"
import { Outbox } from "./outbox"
import { ingest, type SidecarConfig } from "./store-http"

/**
 * Event tap: subscribes to the local OpenCode's event bus and forwards the
 * events that make up chat history (sessions, messages, final parts) to
 * /api/ingest/events in small batches. Streaming deltas are dropped; the
 * final part update carries the full text.
 *
 * Nothing is lost quietly: batches go out in order through an Outbox (a failed
 * one is retried), and every connect to the event stream starts with a resync
 * that re-reads the sessions updated while the tap was not listening (before
 * this sidecar started, or while the stream was down) and forwards them whole.
 * The app's writes are upserts, so a resent message or part changes nothing.
 */

type EngineEvent = { type: string; properties: Record<string, unknown> }
type GlobalEvent = { directory?: string; payload: EngineEvent }
type SessionRow = { id: string; time?: { created?: number; updated?: number } }
type MessageRow = { info: { id: string; time?: { created?: number; completed?: number } }; parts: Record<string, unknown>[] }

const FORWARD = new Set(["session.created", "session.updated", "session.deleted", "message.updated", "message.removed", "message.part.updated", "message.part.removed"])

/** On this sidecar's first connect, sessions updated this far back are resynced (a VM resumed from a snapshot). */
const FIRST_RESYNC_MS = 2 * 60 * 60_000
/** A reconnect resyncs from a little before the stream dropped. */
const RESYNC_MARGIN_MS = 10_000
const RESYNC_MAX_SESSIONS = 20
const RESYNC_MAX_MESSAGES = 100

export type EventTapOptions = { batchMs?: number; retryMs?: number; reconnectMs?: number }

async function* sse<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
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
        yield JSON.parse(data) as T
      } catch {}
    }
  }
}

export function startEventTap(cfg: SidecarConfig, log: Log, opts: EventTapOptions = {}): { flush(): Promise<void> } {
  const outbox = new Outbox<EngineEvent>({
    send: (events) => ingest(cfg, "/api/ingest/events", { events }),
    log,
    name: "events",
    maxBatch: 500,
    maxQueue: 20_000,
    batchMs: opts.batchMs ?? 500,
    retryMs: opts.retryMs ?? 1_000,
  })
  /** Folders the engine reported events for; the resync lists sessions in each (and in the engine's own folder). */
  const directories = new Set<string>()
  /** While a resync runs, live events wait here, so the snapshot never lands after something newer. */
  let held: EngineEvent[] | null = null
  /** Resyncs run one at a time (a quick reconnect must not start a second one over the first's held events). */
  let resyncing: Promise<void> = Promise.resolve()

  const engine = async <T>(path: string, query: Record<string, string> = {}): Promise<T> => {
    const qs = new URLSearchParams(query).toString()
    const res = await fetch(`${cfg.engineUrl}${path}${qs ? `?${qs}` : ""}`, { headers: { authorization: cfg.engineAuth }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`engine ${path} ${res.status}`)
    return (await res.json()) as T
  }

  function forward(ev: EngineEvent) {
    if (held) held.push(ev)
    else outbox.push(ev)
  }

  /** User-typed text arrives as a message without part events; fetch the parts once so history has the prompt. */
  async function hydrateUserParts(sessionID: string, messageID: string) {
    try {
      const j = await engine<{ parts?: Record<string, unknown>[] }>(`/session/${sessionID}/message/${messageID}`)
      for (const part of j.parts ?? []) forward({ type: "message.part.updated", properties: { part } })
    } catch (err) {
      log("sidecar", "events.hydrate_failed", { messageID, err }, { level: "warn" })
    }
  }

  function enqueue(ev: EngineEvent) {
    if (!FORWARD.has(ev.type)) return
    if (ev.type === "message.updated") {
      const info = ev.properties.info as { role?: string; id?: string; sessionID?: string } | undefined
      if (info?.role === "user" && info.id && info.sessionID) void hydrateUserParts(info.sessionID, info.id)
    }
    // Streamed text arrives as many part updates carrying `delta`; only the final one (no delta) is history.
    if (ev.type === "message.part.updated" && ev.properties.delta !== undefined) return
    forward(ev)
  }

  /** Everything about the sessions updated since `since`, as the events that would have built it. Bounded. */
  async function resync(since: number) {
    held = []
    const out: EngineEvent[] = []
    try {
      const lists = await Promise.all([undefined, ...directories].map((d) => engine<SessionRow[]>("/session", d ? { directory: d } : {}).then((rows) => rows.map((s) => ({ s, d })))))
      const seen = new Set<string>()
      const recent = lists
        .flat()
        .filter(({ s }) => !seen.has(s.id) && seen.add(s.id) && (s.time?.updated ?? s.time?.created ?? 0) >= since)
        .sort((a, b) => (b.s.time?.updated ?? 0) - (a.s.time?.updated ?? 0))
        .slice(0, RESYNC_MAX_SESSIONS)
      for (const { s, d } of recent) {
        out.push({ type: "session.updated", properties: { info: s } })
        const query: Record<string, string> = { limit: String(RESYNC_MAX_MESSAGES), ...(d ? { directory: d } : {}) }
        for (const m of await engine<MessageRow[]>(`/session/${s.id}/message`, query)) {
          const t = m.info.time
          if (t?.completed && t.completed < since && (t.created ?? 0) < since) continue
          out.push({ type: "message.updated", properties: { info: m.info } })
          for (const part of m.parts) out.push({ type: "message.part.updated", properties: { part } })
        }
      }
      log("sidecar", "events.resynced", { sessions: recent.length, events: out.length })
    } catch (err) {
      log("sidecar", "events.resync_failed", { message: err instanceof Error ? err.message : String(err) }, { level: "warn" })
    } finally {
      const live = held ?? []
      held = null
      outbox.push(...out, ...live)
    }
  }

  void (async () => {
    let attempt = 0
    /** When the tap last stopped hearing the engine; null before the first connect. */
    let lostAt: number | null = null
    for (;;) {
      attempt++
      try {
        // Headers must arrive within 20 s; the body then streams for as long as the engine lives.
        const headersCtl = new AbortController()
        const headersTimer = setTimeout(() => headersCtl.abort(new Error("no response headers in 20 s")), 20_000)
        const res = await fetch(`${cfg.engineUrl}/global/event`, { headers: { authorization: cfg.engineAuth, accept: "text/event-stream" }, cache: "no-store", signal: headersCtl.signal })
        clearTimeout(headersTimer)
        if (!res.ok) throw new Error(`event stream ${res.status}`)
        log("sidecar", "events.connected", { attempt })
        const stream = sse<GlobalEvent>(res)
        const since = lostAt === null ? Date.now() - FIRST_RESYNC_MS : lostAt - RESYNC_MARGIN_MS
        resyncing = resyncing.then(() => resync(since))
        let n = 0
        try {
          for await (const ev of stream) {
            n++
            if (ev.directory) directories.add(ev.directory)
            enqueue(ev.payload)
          }
        } finally {
          lostAt = Date.now()
        }
        log("sidecar", "events.ended", { received: n }, { level: "warn" })
      } catch (err) {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined
        // The engine starts after the sidecar; the first attempts are expected to fail.
        if (attempt > 3) log("sidecar", "events.error", { attempt, message: err instanceof Error ? err.message : String(err), cause }, { level: "warn" })
      }
      await new Promise((r) => setTimeout(r, opts.reconnectMs ?? 1500))
    }
  })()

  return { flush: () => outbox.flush() }
}
