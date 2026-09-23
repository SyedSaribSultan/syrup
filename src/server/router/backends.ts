import { eq } from "drizzle-orm"
import { db, dbReady, schema } from "../db"
import { engine } from "../engine/opencode"
import { open } from "../vault"

/**
 * Which concrete models the router may send an alias to, in order of
 * preference, and how to reach each provider's OpenAI-compatible endpoint.
 */

export type Alias = "auto" | "fast"

export const ALIASES: Record<Alias, { name: string; description: string }> = {
  auto: { name: "Auto (best available)", description: "Strongest connected model with tool calling and a large context. Fails over on rate limits." },
  fast: { name: "Fast", description: "Quickest connected model for small tasks. Fails over on rate limits." },
}

/** OpenAI-compatible chat completions base URLs. Only providers listed here can be routed. */
export const BASE_URL: Record<string, string> = {
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  cerebras: "https://api.cerebras.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  cohere: "https://api.cohere.ai/compatibility/v1",
  huggingface: "https://router.huggingface.co/v1",
  openai: "https://api.openai.com/v1",
  togetherai: "https://api.together.xyz/v1",
  "fireworks-ai": "https://api.fireworks.ai/inference/v1",
}

/**
 * Preference lists. Verified against the models.dev catalog on 2026-09-23;
 * entries missing from the live catalog are skipped at runtime.
 * Free-tier keys are tried before paid ones regardless of this order.
 */
const PREFER: Record<Alias, [provider: string, model: string][]> = {
  auto: [
    ["google", "gemini-3.8-flash"],
    ["nvidia", "z-ai/glm-5.3"],
    ["nvidia", "deepseek-ai/deepseek-v4-pro-0813"],
    ["nvidia", "moonshotai/kimi-k3"],
    ["mistral", "mistral-medium-latest"],
    ["deepseek", "deepseek-v4-pro"],
    ["openrouter", "*free*"],
    ["cerebras", "gpt-oss-120b"],
    ["groq", "openai/gpt-oss-120b"],
    // Same-provider fallback when the flagship is rate limited or under load.
    ["google", "gemini-3.5-flash-lite"],
    ["cohere", "north-mini-code-1-0"],
    ["huggingface", "deepseek-ai/DeepSeek-V4.1-Flash"],
    ["openai", "gpt-6-luna"],
  ],
  fast: [
    ["groq", "openai/gpt-oss-20b"],
    ["cerebras", "gpt-oss-120b"],
    ["google", "gemini-3.5-flash-lite"],
    ["google", "gemini-flash-lite-latest"],
    ["nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b"],
    ["nvidia", "z-ai/glm-5.3-flash"],
    ["mistral", "mistral-small-latest"],
    ["deepseek", "deepseek-flash"],
    ["openrouter", "*free*"],
    ["groq", "llama-3.3-70b-versatile"],
    ["openai", "gpt-6-luna"],
  ],
}

export type Candidate = {
  providerID: string
  modelID: string
  baseURL: string
  apiKey: string
  keyID: string | null
  tier: "free" | "paid"
  /** List price per 1M tokens, from the catalog. */
  price: { input: number; output: number }
  context: number
}

type CatalogModel = {
  id: string
  cost?: { input: number; output: number }
  limit?: { context: number; output: number }
  tool_call?: boolean
  status?: string
}

let catalogCache: { at: number; byProvider: Map<string, Map<string, CatalogModel>> } | undefined

async function catalog() {
  if (catalogCache && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.byProvider
  const { client } = await engine()
  const res = await client.provider.list()
  const byProvider = new Map<string, Map<string, CatalogModel>>()
  for (const p of res.data?.all ?? []) {
    const models = new Map<string, CatalogModel>()
    for (const m of Object.values(p.models) as CatalogModel[]) models.set(m.id, m)
    byProvider.set(p.id, models)
  }
  catalogCache = { at: Date.now(), byProvider }
  return byProvider
}

type ActiveKey = { id: string | null; secret: string; tier: "free" | "paid" }

/** Active key per routable provider: the vault first, then the environment. */
async function activeKeys(): Promise<Map<string, ActiveKey>> {
  await dbReady()
  const out = new Map<string, ActiveKey>()
  const rows = await db().select().from(schema.providerKeys).where(eq(schema.providerKeys.active, 1))
  for (const r of rows) {
    if (BASE_URL[r.providerId]) out.set(r.providerId, { id: r.id, secret: open(r.secret), tier: r.tier })
  }
  // Fall back to the environment variables OpenCode itself would read.
  for (const providerID of Object.keys(BASE_URL)) {
    if (out.has(providerID)) continue
    for (const name of ENV_NAMES[providerID] ?? []) {
      const v = process.env[name]
      if (v) {
        out.set(providerID, { id: null, secret: v, tier: "free" })
        break
      }
    }
  }
  return out
}

const ENV_NAMES: Record<string, string[]> = {
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  huggingface: ["HF_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  togetherai: ["TOGETHER_API_KEY"],
  "fireworks-ai": ["FIREWORKS_API_KEY"],
}

/** Ordered candidates for an alias given the keys the user has connected. */
export async function candidates(alias: Alias): Promise<Candidate[]> {
  const [cat, keys] = await Promise.all([catalog(), activeKeys()])
  const out: Candidate[] = []
  const seen = new Set<string>()

  const push = (providerID: string, m: CatalogModel, key: ActiveKey) => {
    const k = `${providerID}/${m.id}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({
      providerID,
      modelID: m.id,
      baseURL: BASE_URL[providerID],
      apiKey: key.secret,
      keyID: key.id,
      tier: key.tier,
      price: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
      context: m.limit?.context ?? 0,
    })
  }

  for (const [providerID, modelID] of PREFER[alias]) {
    const key = keys.get(providerID)
    const models = cat.get(providerID)
    if (!key || !models) continue
    if (modelID === "*free*") {
      // Any zero-price, tool-capable model with a decent context, newest first.
      const free = [...models.values()]
        .filter((m) => m.cost && m.cost.input === 0 && m.cost.output === 0 && m.tool_call !== false && (m.limit?.context ?? 0) >= 64_000 && m.status !== "deprecated")
        .slice(0, 6)
      for (const m of free) push(providerID, m, key)
      continue
    }
    const m = models.get(modelID)
    if (m) push(providerID, m, key)
  }

  // Free-tier keys before paid ones; otherwise keep preference order.
  return out.sort((a, b) => Number(a.tier === "paid") - Number(b.tier === "paid"))
}
