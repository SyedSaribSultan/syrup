import type { Log } from "../src/server/shared/log"
import { ingest, type SidecarConfig } from "./store-http"

/**
 * Event tap: subscribes to the local OpenCode's event bus and forwards the
 * events that make up chat history (sessions, messages, final parts) to
 * /api/ingest/events in small batches. Streaming deltas are dropped; the
 * final part update carries the full text.
 */

type EngineEvent = { type: string; properties: Record<string, unknown> }
type GlobalEvent = { directory?: string; payload: EngineEvent }

const FORWARD = new Set(["session.created", "session.updated", "session.deleted", "message.updated", "message.removed", "message.part.updated", "message.part.removed"])

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

export function startEventTap(cfg: SidecarConfig, log: Log): { flush(): Promise<void> } {
  const queue: EngineEvent[] = []
  let timer: NodeJS.Timeout | undefined

  async function flush() {
    if (timer) clearTimeout(timer)
    timer = undefined
    const batch = queue.splice(0, 500)
    if (!batch.length) return
    try {
      await ingest(cfg, "/api/ingest/events", { events: batch })
    } catch (err) {
      log("sidecar", "events.forward_failed", { n: batch.length, err }, { level: "warn" })
    }
  }

  function enqueue(ev: EngineEvent) {
    if (!FORWARD.has(ev.type)) return
    // Streamed text arrives as many part updates carrying `delta`; only the final one (no delta) is history.
    if (ev.type === "message.part.updated" && ev.properties.delta !== undefined) return
    queue.push(ev)
    if (queue.length >= 100) void flush()
    else if (!timer) timer = setTimeout(() => void flush(), 500)
  }

  void (async () => {
    let attempt = 0
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
        let n = 0
        for await (const ev of sse<GlobalEvent>(res)) {
          n++
          enqueue(ev.payload)
        }
        log("sidecar", "events.ended", { received: n }, { level: "warn" })
      } catch (err) {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined
        // The engine starts after the sidecar; the first attempts are expected to fail.
        if (attempt > 3) log("sidecar", "events.error", { attempt, message: err instanceof Error ? err.message : String(err), cause }, { level: "warn" })
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  })()

  return { flush }
}
