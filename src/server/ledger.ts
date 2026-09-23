import type { AssistantMessage, Event, Model } from "@opencode-ai/sdk/client"
import { db, dbReady, schema } from "./db"
import { engine } from "./engine/opencode"

/**
 * The ledger listens to OpenCode's event bus and records every assistant
 * message's tokens and cost. It is the single source for the cost dashboard.
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
    const providers = res.data?.providers ?? []
    for (const p of providers) {
      for (const m of Object.values(p.models) as Model[]) {
        const cost = m.cost
        const free = !cost || (cost.input === 0 && cost.output === 0)
        freeCache.set(`${p.id}/${m.id}`, free)
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

async function run() {
  await dbReady()
  const { client } = await engine()
  // Reconnect forever; the SDK's SSE client retries on its own, but a clean
  // end of stream (server restart) must also be handled.
  for (;;) {
    try {
      const res = await client.event.subscribe()
      for await (const ev of res.stream as AsyncIterable<Event>) {
        if (ev.type === "message.updated" && ev.properties.info.role === "assistant") {
          await record(ev.properties.info)
        }
      }
    } catch (err) {
      console.warn("[syrup] ledger: event stream error, retrying", err)
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
