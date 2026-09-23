import type { AssistantMessage, Event, Model } from "@opencode-ai/sdk/client"
import { db, dbReady, schema } from "./db"
import { engine } from "./engine/opencode"

/**
 * The ledger listens to OpenCode's global event bus (every workspace) and
 * records each assistant message's tokens and cost. It is the single source
 * for the cost dashboard.
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
    console.warn("[syrup] ledger: could not load provider catalog", err)
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

async function run() {
  await dbReady()
  const { url } = await engine()
  // Reconnect forever: the engine instance restarts when keys or skills change.
  for (;;) {
    try {
      const res = await fetch(`${url}/global/event`, { cache: "no-store" })
      if (!res.ok) throw new Error(`global event stream ${res.status}`)
      for await (const ev of sse<GlobalEvent>(res)) {
        const p = ev.payload
        if (p?.type === "message.updated" && p.properties.info.role === "assistant") {
          await record(p.properties.info)
        }
      }
    } catch (err) {
      console.warn("[syrup] ledger: event stream error, retrying", err instanceof Error ? err.message : err)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** Starts the ledger once per process. */
export function startLedger(): Promise<void> {
  if (!g.__syrupLedger) {
    g.__syrupLedger = run().catch((err) => {
      console.error("[syrup] ledger stopped", err)
    })
  }
  return g.__syrupLedger
}
