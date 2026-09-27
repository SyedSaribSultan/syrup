import { createHash } from "node:crypto"
import {
  freeKeyServes,
  freeLimits,
  interleavedField,
  isFree,
  isScarce,
  modelInfo,
  reasoningCapable,
  usableForAgent,
  visionCapable,
  type FreeLimits,
  type ModelInfo,
} from "../../lib/model-registry"
import type { ActiveKey, Catalog, CatalogModel, Tier } from "./store"

/**
 * Which concrete backends (provider + model + key) the router may send an
 * alias to, and how to reach each provider's OpenAI-compatible endpoint.
 * Pure apart from a small cache: given a catalog and the user's keys, returns
 * every usable candidate. Ranking happens per request in policy.ts.
 */

export type Alias = "auto" | "fast"

export const ALIASES: Record<Alias, { name: string; description: string }> = {
  auto: { name: "Auto", description: "Picks the best model for each chat from your keys, sticks with it, and fails over instantly." },
  fast: { name: "Fast", description: "Quickest capable model, low thinking effort." },
}

/**
 * OpenAI-compatible chat completions base URLs. Only providers listed here can be routed;
 * the rest of the app reads this map to tell which keys Auto/Fast can use.
 * OpenCode Zen is deliberately absent: its free tier answers 403 "can only be used from
 * within OpenCode" to proxied requests, so its models are direct picks in the engine only.
 * Cloudflare Workers AI is absent because its URL needs the account id, which a key alone
 * does not carry.
 */
export const BASE_URL: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  zai: "https://api.z.ai/api/paas/v4",
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

/** Environment variables OpenCode itself would read for each provider (local-mode fallback). */
export const ENV_NAMES: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  zai: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
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

/** Providers with no free tier. Local mode ignores their environment keys: only keys added in syrup may spend money. */
export const PAID_ONLY = new Set(["anthropic", "openai", "deepseek", "togetherai", "fireworks-ai"])

export type Candidate = {
  /** provider/model#key: identity for health, cooldowns and stickiness. */
  id: string
  /** provider/model, what logs and the UI show. */
  backend: string
  providerID: string
  /** Catalog id: identity, events and the UI. */
  modelID: string
  /** Model name the provider's API expects (the catalog's api.id when it differs). */
  upstreamModel: string
  baseURL: string
  apiKey: string
  keyID: string | null
  /** provider#key, the scope for key-wide cooldowns, in-flight counts and learned limits. */
  keyScope: string
  tier: Tier
  keyless: boolean
  model: CatalogModel
  info: ModelInfo
  /** USD per million tokens. */
  price: { input: number; output: number }
  context: number
  maxOutput: number
  vision: boolean
  reasoning: boolean
  /** Assistant-message field the model needs echoed back with its tool calls (e.g. reasoning_content). */
  interleaved: string | null
  /** $0 model in the catalog (the free-models-per-day scope on OpenRouter). */
  freeModel: boolean
  /** Using it spends the user's money. */
  costs: boolean
  /** Free-tier limits, when the key is free or keyless. */
  limits: FreeLimits | null
  /** Daily free capacity small enough that routine turns should not spend it. */
  scarce: boolean
  /** Provider allows one request at a time on this key. */
  serial: boolean
}

function keyScopeOf(providerID: string, key: ActiveKey): string {
  return `${providerID}#${key.id ?? (key.secret === "public" ? "public" : "env")}`
}

/** Every usable candidate for the catalog and keys, unordered. */
export function buildCandidates(cat: Catalog, keys: Map<string, ActiveKey>, baseURLs: Record<string, string> = BASE_URL): Candidate[] {
  const out: Candidate[] = []
  for (const [providerID, key] of keys) {
    const baseURL = baseURLs[providerID]
    const models = cat.get(providerID)
    if (!baseURL || !models) continue
    const free = key.tier === "free"
    const keyScope = keyScopeOf(providerID, key)
    for (const m of models.values()) {
      if (!usableForAgent(m)) continue
      // A variant entry (e.g. gpt-6-astra-fast → api.id gpt-6-astra with a priority tier) duplicates its base model,
      // and the router cannot apply the options it exists for.
      const apiID = m.api?.id || m.id
      if (apiID !== m.id && models.has(apiID)) continue
      const freeModel = isFree(m)
      let limits: FreeLimits | null = null
      if (free) {
        if (!freeKeyServes(providerID, m)) continue
        limits = freeLimits(providerID, m.id)
      }
      out.push({
        id: `${providerID}/${m.id}#${keyScope.slice(providerID.length + 1)}`,
        backend: `${providerID}/${m.id}`,
        providerID,
        modelID: m.id,
        upstreamModel: apiID,
        baseURL: baseURL.replace(/\/$/, ""),
        apiKey: key.secret,
        keyID: key.id,
        keyScope,
        tier: key.tier,
        keyless: key.id === null && key.secret === "public",
        model: m,
        info: modelInfo(providerID, m),
        price: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
        context: m.limit?.context ?? 0,
        maxOutput: m.limit?.output ?? 0,
        vision: visionCapable(m),
        reasoning: reasoningCapable(m),
        interleaved: interleavedField(m),
        freeModel,
        costs: !free && !freeModel,
        limits,
        scarce: limits ? isScarce(limits) : false,
        serial: !!limits?.serial,
      })
    }
  }
  return out
}

function keysSignature(keys: Map<string, ActiveKey>): string {
  const parts: string[] = []
  for (const [p, k] of keys) parts.push(`${p}:${k.id ?? "-"}:${k.tier}:${createHash("sha256").update(k.secret).digest("hex").slice(0, 10)}`)
  return parts.sort().join("|")
}

/**
 * buildCandidates with a short cache per (catalog object, keys) so the
 * per-request cost stays at a map lookup. Stores keep returning the same
 * catalog object while their own cache is warm.
 */
export class CandidateCache {
  private byCatalog = new WeakMap<Catalog, { sig: string; at: number; list: Candidate[] }>()
  constructor(
    private baseURLs: Record<string, string>,
    private ttlMs: number,
    private now: () => number,
  ) {}

  get(cat: Catalog, keys: Map<string, ActiveKey>): Candidate[] {
    const sig = keysSignature(keys)
    const hit = this.byCatalog.get(cat)
    const t = this.now()
    if (hit && hit.sig === sig && t - hit.at < this.ttlMs) return hit.list
    const list = buildCandidates(cat, keys, this.baseURLs)
    this.byCatalog.set(cat, { sig, at: t, list })
    return list
  }
}
