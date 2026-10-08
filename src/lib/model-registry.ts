/**
 * What syrup knows about models beyond the catalog: which ones matter for a
 * coding agent, how good and how fast they are, and how scarce their free
 * tiers are. Shared by the router (server) and the model picker (client), so
 * it must stay free of server-only imports.
 *
 * Quality is a 0–100 coding-agent score curated from independent leaderboards
 * (Artificial Analysis Coding Agent Index, DeepSWE, Terminal-Bench 4.0) as of
 * 2026-09-27. Speeds are priors; the router replaces them with measurements.
 */

/** The subset of a models.dev / OpenCode catalog entry this module reads. Both catalog shapes fit. */
export type ModelLike = {
  id: string
  name?: string
  family?: string
  release_date?: string
  status?: string
  tool_call?: boolean
  capabilities?: { toolcall?: boolean; reasoning?: boolean; input?: { image?: boolean }; interleaved?: boolean | { field?: string } }
  cost?: { input: number; output: number }
  limit?: { context?: number; output?: number }
}

export type ModelKind = "chat" | "image" | "video" | "audio" | "embedding" | "safety" | "meta" | "other"

export type Grade = "frontier" | "strong" | "mid" | "small"

export type ModelInfo = {
  quality: number
  grade: Grade
  /** Typical output tokens per second. */
  tps: number
  /** Typical time to first token in ms at default effort, for a mid-size prompt. */
  ttftMs: number
  /**
   * Completion tokens per visible answer token at the model's default effort, reasoning included: 1 for a model that
   * does not think (or thinks minimally by default), more for one whose hidden thinking is decoded before the answer.
   * The router multiplies a session's expected answer length by it on Auto (policy.rank). A prior, not a measurement.
   */
  think: number
  /** Thinks at Google's "minimal" level unless asked for more (Gemini 3.x Flash-Lite), so a turn can ask it to think. */
  lowThinkDefault: boolean
  /** True when the score comes from the curated table rather than a guess. */
  known: boolean
}

/** `think`: ModelInfo.think (default 1 for a listed model). `lowThink`: ModelInfo.lowThinkDefault. */
type Entry = { match: RegExp; q: number; tps?: number; ttft?: number; think?: number; lowThink?: boolean }

/** First match wins, so more specific patterns come first. Matched against the lowercased id with ":free" stripped. */
const TABLE: Entry[] = [
  { match: /claude-opus-5[.-]5/, q: 98, tps: 85, ttft: 8000 },
  { match: /gpt-6-astra/, q: 95, tps: 60, ttft: 9000 },
  { match: /claude-fable-5[.-]1/, q: 94, tps: 63, ttft: 9000 },
  { match: /claude-opus-5(?![.-]\d)/, q: 92, tps: 120, ttft: 6000 },
  { match: /gpt-6-sol/, q: 90, tps: 83, ttft: 6000 },
  { match: /gemini-3\.8-flash(?!-lite)/, q: 88, tps: 320, ttft: 9000, think: 1.8 },
  { match: /gemini-3\.1-pro/, q: 86, tps: 110, ttft: 12000, think: 2 },
  { match: /muse-spark-1\.3/, q: 85, tps: 215, ttft: 20000 },
  // No think multiplier yet: its 45 tok/s prior already reflects a thinking model, and 2.5× on top made a free Kimi
  // lose routine turns to a paid key (router suite w3, z8). Revisit with measured visible-vs-completion tokens.
  { match: /kimi-k3/, q: 84, tps: 45, ttft: 3000 },
  { match: /glm-5[.-]3(?![.-]?flash)/, q: 84, tps: 80, ttft: 3000 },
  { match: /mimo-v2\.6-pro/, q: 82, tps: 44, ttft: 3500 },
  { match: /gemini-3\.7-flash(?!-lite)/, q: 82, tps: 300, ttft: 8000, think: 1.8 },
  { match: /claude-sonnet-5/, q: 80, tps: 80, ttft: 4000 },
  { match: /deepseek-v4-pro/, q: 80, tps: 60, ttft: 4000 },
  { match: /qwen3\.8-max/, q: 78, tps: 39, ttft: 4000 },
  { match: /(^|\/)deepseek-flash$|deepseek-v4\.1-flash/, q: 78, tps: 232, ttft: 1100 },
  { match: /glm-5[.-]2(?![.-]?flash)/, q: 78, tps: 80, ttft: 3000 },
  { match: /gemini-3\.6-flash(?!-lite)/, q: 78, tps: 300, ttft: 8000, think: 1.8 },
  { match: /glm-5[.-]3-flash/, q: 77, tps: 110, ttft: 1500 },
  { match: /mimo-v2\.6-flash/, q: 76, tps: 150, ttft: 2000 },
  { match: /big-pickle/, q: 76, tps: 80, ttft: 2500 },
  { match: /gemini-3\.5-flash(?!-lite)/, q: 75, tps: 280, ttft: 8000, think: 1.8 },
  { match: /space-bunny/, q: 74, tps: 120, ttft: 3000 },
  { match: /nemotron-3-ultra/, q: 74, tps: 195, ttft: 3000, think: 2.5 },
  { match: /deepseek-v4-flash/, q: 72, tps: 200, ttft: 1500 },
  { match: /kimi-k2\.7-code/, q: 72, tps: 60, ttft: 3000 },
  { match: /longcat-2\.5/, q: 72, tps: 100, ttft: 3000 },
  { match: /gemini-3-flash/, q: 72, tps: 250, ttft: 7000, think: 1.8 },
  { match: /kimi-k2\.6/, q: 70, tps: 50, ttft: 3000 },
  { match: /gemini-2\.5-pro/, q: 70, tps: 150, ttft: 10000 },
  { match: /gpt-6-luna/, q: 70, tps: 145, ttft: 2100 },
  { match: /grok-4\.7/, q: 70, tps: 76, ttft: 5000 },
  { match: /mistral-medium-(3\.5|latest|2604)/, q: 70, tps: 90, ttft: 1500 },
  { match: /minimax-m3/, q: 68, tps: 179, ttft: 3000 },
  { match: /qwen3\.5-397b/, q: 66, tps: 60, ttft: 3000 },
  { match: /mistral-large-(3|latest|2512)/, q: 65, tps: 70, ttft: 1500 },
  { match: /devstral/, q: 65, tps: 90, ttft: 1500 },
  { match: /laguna-s-2\.1/, q: 62, tps: 120, ttft: 1500 },
  { match: /inkling(?!-small)/, q: 62, tps: 184, ttft: 2000 },
  { match: /step-3\.7-flash/, q: 60, tps: 150, ttft: 1500 },
  { match: /qwen-?3\.8-27b/, q: 60, tps: 150, ttft: 1000 },
  { match: /gemini-3\.5-flash-lite/, q: 60, tps: 300, ttft: 3000, lowThink: true },
  { match: /gemini-2\.5-flash(?!-lite)/, q: 58, tps: 250, ttft: 5000 },
  { match: /nemotron-3\.5-lightning/, q: 58, tps: 280, ttft: 800 },
  { match: /nemotron-3-super/, q: 58, tps: 150, ttft: 1500 },
  { match: /gemini-3\.1-flash-lite/, q: 55, tps: 300, ttft: 2500, lowThink: true },
  { match: /north-mini-code/, q: 55, tps: 120, ttft: 1500 },
  { match: /glm-4\.7-flash/, q: 55, tps: 90, ttft: 2000 },
  { match: /muse-glimmer/, q: 55, tps: 150, ttft: 1500 },
  { match: /codestral/, q: 55, tps: 150, ttft: 800 },
  { match: /gemma-4-31b/, q: 52, tps: 60, ttft: 2000 },
  { match: /laguna-xs/, q: 50, tps: 200, ttft: 800 },
  { match: /ling-3\.0-flash/, q: 50, tps: 150, ttft: 1500 },
  { match: /mistral-small/, q: 50, tps: 150, ttft: 800 },
  { match: /gpt-oss-120b/, q: 45, tps: 500, ttft: 700 },
  { match: /inkling-small/, q: 45, tps: 250, ttft: 1000 },
  { match: /gemma-4-26b/, q: 45, tps: 80, ttft: 1500 },
  { match: /gemini-2\.5-flash-lite/, q: 40, tps: 300, ttft: 1500 },
  { match: /llama-3\.3-70b/, q: 38, tps: 250, ttft: 600 },
  { match: /gpt-oss-20b/, q: 35, tps: 600, ttft: 500 },
  { match: /llama-3\.1-8b/, q: 20, tps: 700, ttft: 400 },
]

/** Hosts whose hardware makes the same model several times faster. */
const HOST_SPEEDUP: Record<string, number> = { groq: 4, cerebras: 6 }

function norm(id: string): string {
  return id.toLowerCase().replace(/:free$/, "")
}

export function gradeOf(q: number): Grade {
  return q >= 84 ? "frontier" : q >= 72 ? "strong" : q >= 55 ? "mid" : "small"
}

/**
 * Free shared endpoints decode far slower than the paid figures the table holds: OpenRouter's Nemotron 3 Ultra `:free`
 * streamed 129 tokens in 13.3 s and 374 in 21 s (~10–18 tok/s, router_events 2026-10-08) against 148–176 tok/s on
 * paid hosts, and they queue before the first token too. Applied to OpenRouter ids ending in ":free" until the router
 * measures the endpoint itself.
 */
export const FREE_ENDPOINT_TPS = 25
export const FREE_ENDPOINT_TTFT_X = 1.5
/** ModelInfo.think for a model the table does not list that can reason. */
const UNKNOWN_REASONER_THINK = 2

function freeEndpoint(providerID: string, rawId: string): boolean {
  return providerID === "openrouter" && /:free$/i.test(rawId)
}

/** Quality and speed for a model. Unknown models get a conservative guess from recency and size. */
export function modelInfo(providerID: string, m: ModelLike): ModelInfo {
  const id = norm(m.id)
  const hit = TABLE.find((e) => e.match.test(id))
  const speedup = HOST_SPEEDUP[providerID] ?? 1
  // norm() strips ":free", so the endpoint is read from the raw id.
  const free = freeEndpoint(providerID, m.id)
  const slow = (tps: number, ttftMs: number) => (free ? { tps: Math.min(tps, FREE_ENDPOINT_TPS), ttftMs: Math.round(ttftMs * FREE_ENDPOINT_TTFT_X) } : { tps, ttftMs })
  if (hit) {
    const speed = slow((hit.tps ?? 80) * speedup, Math.round((hit.ttft ?? 4000) / Math.sqrt(speedup)))
    return { quality: hit.q, grade: gradeOf(hit.q), ...speed, think: hit.think ?? 1, lowThinkDefault: !!hit.lowThink, known: true }
  }
  let q = 40
  const released = m.release_date ? Date.parse(m.release_date) : NaN
  // Recent, large-context, tool-capable models from unknown labs are usually decent; old ones rarely are.
  if (Number.isFinite(released) && Date.now() - released < 120 * 86_400_000) q += 8
  if ((m.limit?.context ?? 0) >= 200_000) q += 4
  const params = id.match(/(\d+)b\b/)
  if (params && Number(params[1]) < 20) q -= 10
  if (m.cost && m.cost.input >= 3) q += 10
  return { quality: q, grade: gradeOf(q), ...slow(80 * speedup, 4000), think: reasoningCapable(m) ? UNKNOWN_REASONER_THINK : 1, lowThinkDefault: false, known: false }
}

// ---------------------------------------------------------------- classification

const KIND_PATTERNS: [ModelKind, RegExp][] = [
  ["safety", /guard|safety|shield|moderation|content-filter/],
  ["embedding", /embed|(^|\/)bge-|rerank|(^|\/)e5-/],
  ["audio", /tts|whisper|voxtral-mini|orpheus|lyria|audio|speech|transcri|live-translate|voicechat|realtime|native-audio/],
  ["video", /(^|\/|-)veo-|sora|video-gen/],
  ["image", /image|imagen|flux|stable-diffusion|sdxl|dall-e|nano-banana|paligemma|kontext/],
  ["meta", /^openrouter\/(auto|free|fusion|pareto|bodybuilder)|^groq\/compound|computer-use|deep-research/],
  ["other", /esmfold|esm2|evo2|alphafold|genmol|diffdock/],
]

export function kindOf(m: ModelLike): ModelKind {
  const id = norm(m.id)
  for (const [kind, re] of KIND_PATTERNS) if (re.test(id)) return kind
  return "chat"
}

export function toolCapable(m: ModelLike): boolean {
  return (m.capabilities?.toolcall ?? m.tool_call) !== false
}

export function reasoningCapable(m: ModelLike): boolean {
  return !!m.capabilities?.reasoning
}

export function visionCapable(m: ModelLike): boolean {
  return !!m.capabilities?.input?.image
}

/** Field name a thinking model needs echoed back on later turns (e.g. "reasoning_content"), if any. */
export function interleavedField(m: ModelLike): string | null {
  const f = m.capabilities?.interleaved
  if (!f) return null
  if (f === true) return "reasoning_content"
  return f.field ?? "reasoning_content"
}

export function isFree(m: ModelLike): boolean {
  return !m.cost || (m.cost.input === 0 && m.cost.output === 0)
}

/** Can a coding agent use this at all? Non-chat kinds, tool-less, deprecated and tiny-context models cannot. */
export function usableForAgent(m: ModelLike): boolean {
  return kindOf(m) === "chat" && toolCapable(m) && m.status !== "deprecated" && (m.limit?.context ?? 0) >= 32_000
}

/** Size/line markers that separate product lines inside one family (Nemotron Ultra vs Lightning, Qwen 27B vs Max). */
const LINE_MARKERS = /(ultra|super|nano|lightning|mini|small|medium|large|flash-lite|flashx|flash|lite|pro|max|air|turbo|coder|code|vision|vl|omni|xs|highspeed|\d+b)/g

function lineOf(m: ModelLike): string {
  const id = norm(m.id)
  const markers = [...new Set(id.match(LINE_MARKERS) ?? [])].sort().join("+")
  return `${m.family ?? id.replace(/[-.\d]+$/, "")}|${markers}`
}

function isPreview(m: ModelLike): boolean {
  return /preview|exp|beta|alpha/.test(norm(m.id)) || m.status === "beta"
}

function isAlias(m: ModelLike): boolean {
  return /-latest$/.test(norm(m.id))
}

export type Visibility = "current" | "older" | "hidden"

/**
 * Sorts one provider's models into current (shown), older (behind a
 * disclosure: superseded versions, previews, "-latest" aliases) and hidden
 * (unusable for a coding agent).
 */
export function visibility(models: ModelLike[]): Map<string, Visibility> {
  const out = new Map<string, Visibility>()
  const newestByLine = new Map<string, number>()
  const usable = models.filter((m) => {
    if (usableForAgent(m)) return true
    out.set(m.id, "hidden")
    return false
  })
  for (const m of usable) {
    if (isAlias(m) || isPreview(m)) continue
    const t = m.release_date ? Date.parse(m.release_date) : 0
    const line = lineOf(m)
    newestByLine.set(line, Math.max(newestByLine.get(line) ?? 0, t))
  }
  for (const m of usable) {
    const t = m.release_date ? Date.parse(m.release_date) : 0
    const newest = newestByLine.get(lineOf(m))
    if (isAlias(m)) {
      // "-latest" duplicates a dated sibling when one is at least as new; otherwise it is the only way to reach that line.
      out.set(m.id, newest !== undefined && newest >= t ? "older" : "current")
      continue
    }
    // A preview with no stable sibling is the only way to get that line, so it stays current.
    if (newest === undefined) out.set(m.id, isPreview(m) ? "current" : "older")
    else out.set(m.id, t + 14 * 86_400_000 < newest || (isPreview(m) && newest >= t) ? "older" : "current")
  }
  return out
}

// ---------------------------------------------------------------- free-tier capacity

export type FreeLimits = {
  /** Requests per day on the free tier. Undefined = no known daily cap. */
  rpd?: number
  rpm?: number
  /** Tokens per minute. A request larger than this is rejected outright. */
  tpm?: number
  /** The daily cap is shared by every free model on the account. */
  accountWide?: boolean
  /** Only one request at a time. */
  serial?: boolean
}

/**
 * Free-tier limits as of 2026-09-27 (provider docs where published, otherwise
 * consistent third-party reports). Applied only to keys tagged "free" and to
 * keyless providers. The router learns real limits from response headers.
 */
export function freeLimits(providerID: string, modelID: string): FreeLimits {
  const id = norm(modelID)
  switch (providerID) {
    case "google":
      if (/gemma/.test(id)) return { tpm: 15_000, rpm: 30 }
      if (/flash-lite/.test(id)) return { rpd: 500, rpm: 15 }
      if (/flash/.test(id)) return { rpd: 20, rpm: 10 }
      return { rpd: 0 }
    case "openrouter":
      return { rpd: 50, rpm: 20, accountWide: true }
    case "nvidia":
      return { rpm: 40 }
    case "groq":
      return { tpm: 8_000, rpm: 30, rpd: 1_000 }
    case "cerebras":
      return { tpm: 30_000, rpm: 5 }
    case "cohere":
      return { rpd: 33, rpm: 20 }
    case "mistral":
      return { rpd: 60 }
    case "zai":
    case "zhipuai":
      return { serial: true }
    case "opencode":
      return { rpm: 20 }
    default:
      return {}
  }
}

/** Daily capacity is scarce enough that routine turns should not spend it. */
export function isScarce(l: FreeLimits): boolean {
  return l.rpd !== undefined && l.rpd <= 60
}

/** Providers whose free-tier key also serves models the catalog lists with a price. Everyone else's free key only gets $0 models. */
export const FREE_KEY_COVERS_PAID: ReadonlySet<string> = new Set(["google", "nvidia", "groq", "cerebras", "mistral", "cohere"])

/** Whether a key tagged "free" can use this model at all (the router's candidate rule). */
export function freeKeyServes(providerID: string, m: ModelLike): boolean {
  if (!isFree(m) && !FREE_KEY_COVERS_PAID.has(providerID)) return false
  return freeLimits(providerID, m.id).rpd !== 0
}

// ---------------------------------------------------------------- display

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  opencode: "OpenCode Zen",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA",
  mistral: "Mistral",
  groq: "Groq",
  cerebras: "Cerebras",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  openai: "OpenAI",
  zai: "Z.ai",
  zhipuai: "Zhipu",
  moonshotai: "Moonshot",
  syrup: "syrup",
}

export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

/** A readable model name: the catalog name without "Free"/vendor noise, falling back to a tidied id. */
export function displayName(m: ModelLike): string {
  const base = (m.name ?? m.id.split("/").pop() ?? m.id)
    .replace(/\s*\((free|contributor)\)/gi, "")
    .replace(/\s+(contributor\s+)?free$/i, "")
    .trim()
  return base || m.id
}

export function costTier(m: ModelLike): 0 | 1 | 2 | 3 {
  if (isFree(m)) return 0
  const blended = (m.cost!.input * 3 + m.cost!.output) / 4
  return blended < 1 ? 1 : blended < 5 ? 2 : 3
}
