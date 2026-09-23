import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db, dbReady, schema } from "./db"
import { engine } from "./engine/opencode"
import { hint, open, seal } from "./vault"

/**
 * Provider keys. OpenCode holds one active key per provider (its auth store);
 * syrup's vault holds as many as the user adds, with a label and a tier.
 * Activating a key writes it into OpenCode and reloads the engine instance.
 */

export type Tier = "free" | "paid"

export type KeyInfo = {
  id: string
  label: string
  tier: Tier
  hint: string
  active: boolean
  createdAt: number
}

export type ProviderInfo = {
  id: string
  name: string
  connected: boolean
  models: number
  freeModels: number
  env: string[]
  keys: KeyInfo[]
  curated?: Curated
}

export type Curated = {
  /** Order in the recommended list. */
  rank: number
  /** Where to create a key. */
  keyUrl: string
  /** One-line note on the free tier, or the pricing model. */
  note: string
  freeTier: boolean
  /** Prompts may be used for training on this tier. */
  trainsOnData?: boolean
}

// Verified against provider docs in Sept 2026. Free tiers change often; the
// UI labels this as guidance, not a promise.
export const CURATED: Record<string, Curated> = {
  google: {
    rank: 1,
    keyUrl: "https://aistudio.google.com/apikey",
    note: "Best free frontier model. Gemini Flash with 1M context and tool calling, no card needed.",
    freeTier: true,
    trainsOnData: true,
  },
  mistral: {
    rank: 2,
    keyUrl: "https://console.mistral.ai/api-keys",
    note: "Experiment tier: roughly 1B tokens/month including Devstral and Codestral coding models.",
    freeTier: true,
    trainsOnData: true,
  },
  openrouter: {
    rank: 3,
    keyUrl: "https://openrouter.ai/settings/keys",
    note: "One key, hundreds of models. Free models at 50 requests/day, 1,000/day after a one-time $10 top-up.",
    freeTier: true,
  },
  groq: {
    rank: 4,
    keyUrl: "https://console.groq.com/keys",
    note: "Very fast, free, but only 6k–12k tokens/minute. Good for small, quick tasks.",
    freeTier: true,
  },
  nvidia: {
    rank: 5,
    keyUrl: "https://build.nvidia.com",
    note: "Around 1,000 requests/day on open models.",
    freeTier: true,
  },
  cerebras: {
    rank: 6,
    keyUrl: "https://cloud.cerebras.ai",
    note: "Fastest inference. No-card free tier ended mid-2026; new accounts get a $5 trial with a card.",
    freeTier: false,
  },
  deepseek: {
    rank: 7,
    keyUrl: "https://platform.deepseek.com/api_keys",
    note: "Very cheap paid API with strong coding models.",
    freeTier: false,
  },
  anthropic: {
    rank: 8,
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "Paid. Claude models are the strongest for agentic coding when a task deserves it.",
    freeTier: false,
  },
  openai: {
    rank: 9,
    keyUrl: "https://platform.openai.com/api-keys",
    note: "Paid. GPT models.",
    freeTier: false,
  },
  cohere: {
    rank: 10,
    keyUrl: "https://dashboard.cohere.com/api-keys",
    note: "Trial key: about 1,000 calls/month, non-commercial use only.",
    freeTier: true,
  },
  huggingface: {
    rank: 11,
    keyUrl: "https://huggingface.co/settings/tokens",
    note: "Community-rate-limited access to open models.",
    freeTier: true,
  },
  "cloudflare-workers-ai": {
    rank: 12,
    keyUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    note: "Daily free neuron allowance on open models. Small context windows.",
    freeTier: true,
  },
}

type ModelLike = { cost?: { input: number; output: number } }

function freeCount(p: { models: Record<string, ModelLike> }): number {
  let n = 0
  for (const m of Object.values(p.models)) {
    const c = m.cost
    if (!c || (c.input === 0 && c.output === 0)) n++
  }
  return n
}

export async function listProviders(): Promise<{ providers: ProviderInfo[]; default: Record<string, string> }> {
  await dbReady()
  const { client } = await engine()
  const res = await client.provider.list()
  if (!res.data) throw new Error("engine: could not list providers")
  const connected = new Set(res.data.connected)
  const rows = await db().select().from(schema.providerKeys)
  const keysBy = new Map<string, KeyInfo[]>()
  for (const r of rows) {
    const list = keysBy.get(r.providerId) ?? []
    list.push({ id: r.id, label: r.label, tier: r.tier, hint: r.hint, active: r.active === 1, createdAt: r.createdAt })
    keysBy.set(r.providerId, list)
  }
  const providers: ProviderInfo[] = res.data.all.map((p) => ({
    id: p.id,
    name: p.name,
    connected: connected.has(p.id),
    models: Object.keys(p.models).length,
    freeModels: freeCount(p),
    env: p.env,
    keys: keysBy.get(p.id) ?? [],
    curated: CURATED[p.id],
  }))
  return { providers, default: res.data.default }
}

async function setEngineKey(providerID: string, key: string | null) {
  const { client, url } = await engine()
  if (key) {
    await client.auth.set({ path: { id: providerID }, body: { type: "api", key } })
  } else {
    // The v1 SDK has no typed wrapper for DELETE /auth/{id}; call it directly.
    const res = await fetch(`${url}/auth/${encodeURIComponent(providerID)}`, { method: "DELETE" })
    if (!res.ok) throw new Error(`engine: could not remove auth (${res.status})`)
  }
  // Providers are resolved when the instance boots; reload so the change is live.
  await client.instance.dispose()
}

export async function addKey(providerID: string, key: string, label: string, tier: Tier): Promise<KeyInfo> {
  await dbReady()
  const d = db()
  const id = `key_${crypto.randomBytes(8).toString("hex")}`
  const now = Date.now()
  // A new key becomes the active one.
  await d.update(schema.providerKeys).set({ active: 0 }).where(eq(schema.providerKeys.providerId, providerID))
  await d.insert(schema.providerKeys).values({
    id,
    providerId: providerID,
    label: label || `${providerID} key`,
    secret: seal(key),
    hint: hint(key),
    tier,
    enabled: 1,
    active: 1,
    createdAt: now,
  })
  await setEngineKey(providerID, key)
  return { id, label: label || `${providerID} key`, tier, hint: hint(key), active: true, createdAt: now }
}

export async function activateKey(providerID: string, keyID: string): Promise<void> {
  await dbReady()
  const d = db()
  const [row] = await d
    .select()
    .from(schema.providerKeys)
    .where(and(eq(schema.providerKeys.id, keyID), eq(schema.providerKeys.providerId, providerID)))
  if (!row) throw new Error("key not found")
  await d.update(schema.providerKeys).set({ active: 0 }).where(eq(schema.providerKeys.providerId, providerID))
  await d.update(schema.providerKeys).set({ active: 1 }).where(eq(schema.providerKeys.id, keyID))
  await setEngineKey(providerID, open(row.secret))
}

export async function removeKey(providerID: string, keyID: string): Promise<void> {
  await dbReady()
  const d = db()
  const [row] = await d
    .select()
    .from(schema.providerKeys)
    .where(and(eq(schema.providerKeys.id, keyID), eq(schema.providerKeys.providerId, providerID)))
  if (!row) return
  await d.delete(schema.providerKeys).where(eq(schema.providerKeys.id, keyID))
  if (row.active === 1) {
    // Fall back to the newest remaining key, or disconnect the provider.
    const rest = await d.select().from(schema.providerKeys).where(eq(schema.providerKeys.providerId, providerID))
    const next = rest.sort((a, b) => b.createdAt - a.createdAt)[0]
    if (next) {
      await d.update(schema.providerKeys).set({ active: 1 }).where(eq(schema.providerKeys.id, next.id))
      await setEngineKey(providerID, open(next.secret))
    } else {
      await setEngineKey(providerID, null)
    }
  }
}

/** Plaintext of the active key for a provider. Used by the router. */
export async function activeKey(providerID: string): Promise<string | null> {
  await dbReady()
  const [row] = await db()
    .select()
    .from(schema.providerKeys)
    .where(and(eq(schema.providerKeys.providerId, providerID), eq(schema.providerKeys.active, 1)))
  return row ? open(row.secret) : null
}
