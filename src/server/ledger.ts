import type { AssistantMessage, Event, Model } from "@opencode-ai/sdk/client"
import { db, dbReady, schema } from "./db"
import { engine } from "./engine/opencode"
import { slog } from "./log"

/**
 * The ledger listens to OpenCode's global event bus (every workspace),
 * records each assistant message's tokens and cost, and mirrors every
 * engine event into the application log.
 */

const g = globalThis as unknown as { __syrupLedger?: Promise<void> }

// providerID/modelID -> is the list price zero?
const freeCache = new Map<string, boolean>()

async function isFreeModel(providerId: string, modelId: string): Promise<boolean> {
  const key = `${providerId}/${modelId}`
  const cached = freeCache.get(key)
  if (cached !== undefined) return cached
  try {
    const { client } = await engine()
    const res = await client.config.providers()
    for (const p of res.data?.providers ?? []) {
      for (const m of Object.values(p.models) as Model[]) {
        const cost = m.cost
        freeCache.set(`${p.id}/${m.id}`, !cost || (cost.input === 0 && cost.output === 0))
      }
    }
  } catch (err) {
    slog("ledger", "catalog.failed", err, { level: "warn" })
  }
  return freeCache.get(key) ?? false
}

async function record(msg: AssistantMessage) {
  const free = await isFreeModel(msg.providerID, msg.modelID)
  const t = msg.tokens
  const row = {
    messageId: msg.id,
    sessionId: msg.sessionID,
    providerId: msg.providerID,
    modelId: msg.modelID,
    // Newer servers send `agent`; older SDK types only know `mode`.
    agent: (msg as AssistantMessage & { agent?: string }).agent ?? msg.mode ?? null,
    inputTokens: t.input,
    outputTokens: t.output,
    reasoningTokens: t.reasoning,
    cacheReadTokens: t.cache.read,
    cacheWriteTokens: t.cache.write,
    cost: msg.cost,
    free: free ? 1 : 0,
    createdAt: msg.time.created,
    completedAt: msg.time.completed ?? null,
  }
  await db()
    .insert(schema.usageEvents)
    .values(row)
    .onConflictDoUpdate({ target: schema.usageEvents.messageId, set: row })
}

type GlobalEvent = { directory?: string; payload: Event }

/** Reads `data:` lines from an SSE stream and yields parsed JSON. */
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

/**
 * Mirrors an engine event into the log. Streaming text/reasoning deltas are
 * summarised (id, type, length) because the full text lands in the message;
 * everything else is stored whole.
 */
function logEvent(ev: GlobalEvent) {
  const p = ev.payload as { type: string; properties: Record<string, unknown> }
  const props = p.properties ?? {}
  const sessionId = (props.sessionID as string) ?? (props.info as { sessionID?: string })?.sessionID ?? (props.part as { sessionID?: string })?.sessionID ?? null
  const base = { sessionId, directory: ev.directory ?? null }

  switch (p.type) {
    case "message.part.delta":
    case "server.heartbeat":
      // One event per streamed chunk / every 10s: pure noise in a log. The final part is logged on update.
      return
    case "message.part.updated": {
      const part = props.part as { id: string; messageID: string; type: string; text?: string; tool?: string; state?: { status?: string; title?: string; input?: unknown; output?: string; error?: string; time?: unknown }; files?: string[] }
      if (part.type === "text" || part.type === "reasoning") {
        // Only log the final state of a streamed text part (no `delta` on the event) to keep volume sane.
        if (props.delta !== undefined) return
        slog("engine", `part.${part.type}`, { id: part.id, messageID: part.messageID, chars: part.text?.length ?? 0, preview: part.text?.slice(0, 200) }, { ...base, level: "debug" })
        return
      }
      if (part.type === "tool") {
        const st = part.state ?? {}
        slog("engine", `tool.${st.status ?? "update"}`, { id: part.id, messageID: part.messageID, tool: part.tool, title: st.title, input: st.input, output: st.status === "completed" ? st.output : undefined, error: st.error, time: st.time }, { ...base, level: st.status === "error" ? "warn" : "info" })
        return
      }
      slog("engine", `part.${part.type}`, part, { ...base, level: "debug" })
      return
    }
    case "message.updated": {
      const info = props.info as AssistantMessage & { role: string; error?: unknown }
      slog(
        "engine",
        `message.${info.role}${info.time?.completed ? ".completed" : ""}`,
        info.role === "assistant"
          ? { id: info.id, providerID: info.providerID, modelID: info.modelID, agent: (info as { agent?: string }).agent ?? info.mode, tokens: info.tokens, cost: info.cost, time: info.time, error: info.error, summary: info.summary }
          : { id: info.id, time: info.time },
        { ...base, level: info.error ? "error" : "debug" },
      )
      return
    }
    case "session.error":
      slog("engine", "session.error", props, { ...base, level: "error" })
      return
    case "session.status":
      slog("engine", `session.status.${(props.status as { type?: string })?.type ?? "?"}`, props.status, { ...base, level: (props.status as { type?: string })?.type === "retry" ? "warn" : "debug" })
      return
    case "permission.asked":
    case "permission.updated":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
    case "session.created":
    case "session.updated":
    case "session.deleted":
    case "session.idle":
    case "session.compacted":
    case "file.edited":
    case "todo.updated":
    case "lsp.updated":
    case "mcp.tools.changed":
    case "installation.updated":
      slog("engine", p.type, props, base)
      return
    default:
      slog("engine", p.type, props, { ...base, level: "debug" })
  }
}

async function run() {
  await dbReady()
  const { url } = await engine()
  // Reconnect forever: the engine instance restarts when keys or skills change.
  for (;;) {
    try {
      const res = await fetch(`${url}/global/event`, { cache: "no-store" })
      if (!res.ok) throw new Error(`global event stream ${res.status}`)
      slog("ledger", "event_stream.connected", { url })
      for await (const ev of sse<GlobalEvent>(res)) {
        try {
          logEvent(ev)
        } catch (err) {
          slog("ledger", "event.log_failed", err, { level: "warn" })
        }
        const p = ev.payload
        if (p?.type === "message.updated" && p.properties.info.role === "assistant") {
          await record(p.properties.info)
        }
      }
      slog("ledger", "event_stream.ended", {}, { level: "warn" })
    } catch (err) {
      slog("ledger", "event_stream.error", err, { level: "warn" })
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** Starts the ledger once per process. */
export function startLedger(): Promise<void> {
  if (!g.__syrupLedger) {
    g.__syrupLedger = run().catch((err) => {
      slog("ledger", "stopped", err, { level: "error" })
    })
  }
  return g.__syrupLedger
}
