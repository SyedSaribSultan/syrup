import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db, dbReady, schema } from "./db"
import { engine, engineAuthHeader } from "./engine/opencode"
import { slog } from "./log"
import { BASE_URL } from "./router/backends"
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
  /** Auto and Fast can route to it. Everyone else is a direct pick in the model picker only. */
  routable: boolean
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
// UI labels this as guidance, not a promise. Rank is the order in "Add next":
// value for a free setup first (quality x daily volume), then paid picks.
// "syrup" (the router) and "opencode" (OpenCode Zen, keyless free models) are
// built in and deliberately absent: they never take a key.
export const CURATED: Record<string, Curated> = {
  google: {
    rank: 1,
    keyUrl: "https://aistudio.google.com/apikey",
    note: "Best free quality: Gemini 3.8 Flash with 1M context, but only ~20 requests/day on the free tier (Flash-Lite ~500). Pro models are paid only. Free tier may train on prompts.",
    freeTier: true,
    trainsOnData: true,
  },
  nvidia: {
    rank: 2,
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    note: "Largest free volume: ~40 requests/min with no published daily cap. Free Kimi K3, GLM-5.3, DeepSeek V4 and Nemotron. Terms: development and evaluation use.",
    freeTier: true,
  },
  openrouter: {
    rank: 3,
    keyUrl: "https://openrouter.ai/settings/keys",
    note: "One key, 20+ free models including 1M-context ones. 50 free requests/day shared across all free models; 1,000/day after a one-time $10 purchase.",
    freeTier: true,
  },
  mistral: {
    rank: 4,
    keyUrl: "https://console.mistral.ai/api-keys",
    note: "Free plan: $10 of API credits every month, no card (phone verification). Devstral, Medium 3.5, Codestral. Turn off training in Privacy settings.",
    freeTier: true,
    trainsOnData: true,
  },
  zai: {
    rank: 5,
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    note: "GLM-4.7-Flash is free with no daily cap, one request at a time. GLM-5.3 is a cheap paid upgrade.",
    freeTier: true,
  },
  cohere: {
    rank: 6,
    keyUrl: "https://dashboard.cohere.com/api-keys",
    note: "Trial key: 1,000 calls/month on North Mini Code (256K context). Non-commercial use.",
    freeTier: true,
  },
  groq: {
    rank: 7,
    keyUrl: "https://console.groq.com/keys",
    note: "Very fast, but the free tier allows 8K tokens/minute — too small for agent turns. syrup uses it only for quick side tasks.",
    freeTier: true,
  },
  deepseek: {
    rank: 8,
    keyUrl: "https://platform.deepseek.com/api_keys",
    note: "Paid, very cheap: DeepSeek V4.1 Flash is fast at $0.15 / $0.60 per million tokens.",
    freeTier: false,
  },
  anthropic: {
    rank: 9,
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "Paid, strongest: Claude Opus 5.5 leads coding-agent benchmarks.",
    freeTier: false,
  },
  openai: {
    rank: 10,
    keyUrl: "https://platform.openai.com/api-keys",
    note: "Paid. GPT-6 Sol is a strong value pick; Astra for the hardest work.",
    freeTier: false,
  },
  cerebras: {
    rank: 11,
    keyUrl: "https://cloud.cerebras.ai",
    note: "No free tier any more: a $5 trial with a card, 30K tokens/minute.",
    freeTier: false,
  },
  huggingface: {
    rank: 12,
    keyUrl: "https://huggingface.co/settings/tokens",
    note: "Community-rate-limited access to open models.",
    freeTier: true,
  },
  "cloudflare-workers-ai": {
    rank: 13,
    keyUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    note: "10,000 neurons/day — only a few agent turns.",
    freeTier: true,
  },
}

/** Providers syrup ships with. They never take a key and never show a key form. */
export const BUILT_IN = new Set(["syrup", "opencode"])

/** The router has an endpoint for this provider, so Auto and Fast can use its keys. */
export function isRoutable(providerID: string): boolean {
  return Object.hasOwn(BASE_URL, providerID)
}

/** Tier a new key gets when none is chosen: free only where the provider has a free tier. */
export function defaultTier(providerID: string): Tier {
  return CURATED[providerID]?.freeTier ? "free" : "paid"
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
    routable: isRoutable(p.id),
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
    const res = await fetch(`${url}/auth/${encodeURIComponent(providerID)}`, { method: "DELETE", headers: { authorization: engineAuthHeader() } })
    if (!res.ok) throw new Error(`engine: could not remove auth (${res.status})`)
  }
  // Providers are resolved when the instance boots; reload so the change is live.
  await client.instance.dispose()
  slog("providers", key ? "engine.key_set" : "engine.key_removed", { providerID, hint: key ? hint(key) : null })
  slog("engine", "instance.reloaded", { reason: "provider key changed", providerID })
}

export async function addKey(providerID: string, key: string, label: string, tier: Tier): Promise<KeyInfo> {
  if (BUILT_IN.has(providerID)) throw new Error(`${providerID} is built in and does not take a key`)
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
  slog("providers", "key.added", { providerID, keyId: id, label, tier, hint: hint(key) })
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
  slog("providers", "key.activated", { providerID, keyId: keyID, label: row.label, tier: row.tier })
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
  slog("providers", "key.removed", { providerID, keyId: keyID, label: row.label, wasActive: row.active === 1 })
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
