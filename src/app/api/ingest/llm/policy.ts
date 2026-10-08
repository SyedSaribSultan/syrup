import { FREE_KEY_COVERS_PAID, freeLimits, isFree, usableForAgent } from "../../../../lib/model-registry"
import { catalogFrom } from "../../../../server/router/catalog"
import type { Catalog, CatalogModel } from "../../../../server/router/store"

/**
 * The relay's spend policy: which models a key may be used for, checked on the
 * app side for every chat call, whoever holds the sandbox's ingest token.
 *
 * The router in the sandbox only ever picks models its candidate rules allow
 * (backends.ts: usableForAgent, and freeKeyServes for keys tagged free). The
 * token is readable inside the sandbox, so the relay re-applies those rules
 * itself instead of trusting the caller:
 * - a key tagged free may call only what a free key serves: on providers whose
 *   free tier covers listed prices (Google, Mistral, …) the models with a free
 *   quota, elsewhere $0 models only (OpenRouter's ":free" ids, or $0 in the
 *   catalog);
 * - a paid key may call only a model the catalog lists for that provider and
 *   the router could pick, with max_tokens and max_completion_tokens capped at
 *   the model's output limit;
 * - n (several answers per call) is refused for every key.
 * The catalog is models.dev, the one OpenCode in the sandbox reads, loaded by
 * the app itself (CatalogCache below), never taken from the sandbox.
 *
 * Pure: no Next.js and no database imports (scripts/test-llm-proxy.mjs bundles it).
 */

export type Tier = "free" | "paid"

export type PolicyResult =
  | { ok: true; model: string; costs: boolean; maxTokens: number | null; capped: boolean }
  | { ok: false; message: string }
  /** The decision needs the catalog and none was given. */
  | { ok: "catalog" }

/** The catalog entry the relay will call: by catalog id, or by the API name the router sends (api.id). */
export function findModel(cat: Catalog, provider: string, model: string): CatalogModel | undefined {
  const models = cat.get(provider)
  if (!models) return undefined
  const byId = models.get(model)
  if (byId) return byId
  for (const m of models.values()) if (m.api?.id === model) return m
  return undefined
}

function outputBudget(body: Record<string, unknown>): number | null {
  const vals = [body.max_tokens, body.max_completion_tokens].filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  return vals.length ? Math.max(...vals) : null
}

/**
 * Checks one chat request body for a key of the given tier. May cap the
 * output budget in place (`capped`: the body must be re-serialised).
 */
export function checkPolicy(provider: string, tier: Tier, body: Record<string, unknown>, cat: Catalog | null): PolicyResult {
  const model = body.model
  if (typeof model !== "string" || !model) return { ok: false, message: "the request names no model" }
  if (body.n !== undefined && body.n !== 1) return { ok: false, message: "n must be 1 through syrup's relay" }
  // Messages name the model; a caller-supplied id is cut short there.
  const shown = model.length > 120 ? `${model.slice(0, 120)}…` : model

  if (tier === "free") {
    // Name rules only, no catalog: the common case costs nothing.
    if (FREE_KEY_COVERS_PAID.has(provider)) {
      return freeLimits(provider, model).rpd === 0 ? { ok: false, message: `${shown} has no free quota on a free ${provider} key` } : { ok: true, model, costs: false, maxTokens: outputBudget(body), capped: false }
    }
    if (provider === "openrouter" && model.endsWith(":free")) return { ok: true, model, costs: false, maxTokens: outputBudget(body), capped: false }
    if (!cat) return { ok: "catalog" }
    const m = findModel(cat, provider, model)
    if (!m) return { ok: false, message: `${shown} is not in the ${provider} catalog` }
    if (!isFree(m) || freeLimits(provider, m.id).rpd === 0) return { ok: false, message: `${shown} is not free, and this ${provider} key is tagged free` }
    return { ok: true, model, costs: false, maxTokens: outputBudget(body), capped: false }
  }

  if (!cat) return { ok: "catalog" }
  const m = findModel(cat, provider, model)
  if (!m || !usableForAgent(m)) return { ok: false, message: `${shown} is not a ${provider} model syrup's router can pick` }
  const cap = m.limit?.output ?? 0
  let capped = false
  if (cap > 0) {
    for (const f of ["max_tokens", "max_completion_tokens"] as const) {
      const v = body[f]
      if (typeof v === "number" && v > cap) {
        body[f] = cap
        capped = true
      }
    }
  }
  return { ok: true, model, costs: !isFree(m), maxTokens: outputBudget(body), capped }
}

/**
 * Token counts from an answer streamed or returned by an OpenAI-compatible
 * provider: the last usage object seen. Fed chunk by chunk; keeps a short tail
 * so a number split across chunks is still read.
 */
export class UsageSniffer {
  prompt: number | null = null
  completion: number | null = null
  private tail = ""
  private dec = new TextDecoder()

  push(chunk: Uint8Array) {
    const text = this.tail + this.dec.decode(chunk, { stream: true })
    for (const m of text.matchAll(/"prompt_tokens"\s*:\s*(\d+)/g)) this.prompt = Number(m[1])
    for (const m of text.matchAll(/"completion_tokens"\s*:\s*(\d+)/g)) this.completion = Number(m[1])
    this.tail = text.slice(-64)
  }
}

export type CatalogCacheOptions = {
  /** A loaded catalog is reloaded in the background once it is this old. */
  refreshMs?: number
  /** Least time between two failed loads. */
  retryMs?: number
  /** A load that takes longer fails (the waiting request gets a relay error, not a hang). */
  timeoutMs?: number
  now?: () => number
  onError?: (err: unknown) => void
}

/**
 * One models.dev catalog per instance, loaded on first need and kept: a stale
 * catalog is served while one background load refreshes it. Only paid keys, and
 * free keys on providers without a name rule, ever wait for it.
 */
export class CatalogCache {
  private value: { cat: Catalog; at: number } | null = null
  private loading: Promise<Catalog> | null = null
  private failedAt = -Infinity
  private refreshMs: number
  private retryMs: number
  private timeoutMs: number
  private now: () => number
  private onError: (err: unknown) => void

  constructor(
    private load: () => Promise<Catalog>,
    opts: CatalogCacheOptions = {},
  ) {
    this.refreshMs = opts.refreshMs ?? 6 * 60 * 60_000
    this.retryMs = opts.retryMs ?? 30_000
    this.timeoutMs = opts.timeoutMs ?? 8_000
    this.now = opts.now ?? Date.now
    this.onError = opts.onError ?? (() => {})
  }

  /** The catalog in memory, or null. Starts a load when there is none or it is old. */
  peek(): Catalog | null {
    if (!this.value || this.now() - this.value.at >= this.refreshMs) this.warm()
    return this.value?.cat ?? null
  }

  /** Starts a background load unless one is running, or the last one failed too recently. */
  warm(): void {
    if (this.loading || this.now() - this.failedAt < this.retryMs) return
    this.start().catch(() => {})
  }

  /** The catalog, waiting for a load when none is in memory. */
  async get(): Promise<Catalog> {
    const cat = this.peek()
    if (cat) return cat
    return this.loading ?? this.start()
  }

  private start(): Promise<Catalog> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const p = Promise.race([
      this.load(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`model catalog did not load within ${this.timeoutMs / 1000} s`)), this.timeoutMs)
        timer.unref?.()
      }),
    ])
      .then((cat) => {
        this.value = { cat, at: this.now() }
        return cat
      })
      .catch((err: unknown) => {
        this.failedAt = this.now()
        this.onError(err)
        throw err
      })
      .finally(() => {
        clearTimeout(timer)
        if (this.loading === p) this.loading = null
      })
    this.loading = p
    return p
  }
}

/** models.dev's api.json ({ [provider]: { id, models } }) → Catalog, keeping only the providers the relay serves. */
export function catalogFromModelsDev(json: unknown, providers: Iterable<string>): Catalog {
  const keep = new Set(providers)
  const list = json && typeof json === "object" ? Object.values(json as Record<string, { id?: unknown; models?: unknown }>) : []
  return catalogFrom(list.filter((p): p is { id: string; models: Record<string, unknown> } => typeof p?.id === "string" && keep.has(p.id) && !!p.models && typeof p.models === "object"))
}
