import type { MemoryRecord, MemoryStore } from "../src/server/memory/tools"
import { BASE_URL } from "../src/server/router/backends"
import { catalogFrom } from "../src/server/router/catalog"
import type { ActiveKey, Catalog, RouterEvent, RouterStore } from "../src/server/router/store"
import type { Log } from "../src/server/shared/log"

/**
 * provider id -> the user's active key for it: id and tier only. The sidecar
 * never holds a provider secret: its router reaches providers through the
 * app's LLM relay (/api/ingest/llm/<provider>/...), which adds the real key.
 */
export type KeyMeta = Record<string, { id: string; tier: "free" | "paid" }>

/** Everything the sidecar is told at start, all through process env. */
export type SidecarConfig = {
  port: number
  secret: string
  /** Key metadata at start, from SYRUP_ROUTER_KEYS. HttpRouterStore refreshes its own copy. */
  keyMeta: KeyMeta
  ingestUrl: string
  /** Bearer for every call to the app, the relay included. Bound to one user + workspace, valid for one sandbox session. */
  ingestToken: string
  engineUrl: string
  engineAuth: string
  /** Gzip large LLM request bodies to the relay (SYRUP_RELAY_GZIP=1). */
  relayGzip: boolean
  /** The bundle hash the app started this sidecar from (SYRUP_SIDECAR_BUNDLE), reported on /health. */
  bundle: string | null
}

export function readSidecarEnv(): SidecarConfig {
  const need = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`sidecar: ${k} is required`)
    return v
  }
  const password = need("OPENCODE_SERVER_PASSWORD")
  const cfg: SidecarConfig = {
    port: Number(process.env.SYRUP_ROUTER_PORT ?? 4210),
    secret: need("SYRUP_INTERNAL_SECRET"),
    keyMeta: parseKeyMeta(JSON.parse(need("SYRUP_ROUTER_KEYS"))),
    ingestUrl: need("SYRUP_INGEST_URL").replace(/\/$/, ""),
    ingestToken: need("SYRUP_INGEST_TOKEN"),
    engineUrl: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    engineAuth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    relayGzip: process.env.SYRUP_RELAY_GZIP === "1",
    bundle: process.env.SYRUP_SIDECAR_BUNDLE || null,
  }
  // Out of anything this process later spawns or dumps. Cosmetic against a same-user reader: /proc/<pid>/environ keeps
  // the environment the process started with.
  delete process.env.SYRUP_INGEST_TOKEN
  return cfg
}

/** The relay URL the router uses as each provider's base URL. Every provider call then goes to the app, never to a provider directly. */
export function relayBaseURLs(cfg: Pick<SidecarConfig, "ingestUrl">): Record<string, string> {
  return Object.fromEntries(Object.keys(BASE_URL).map((p) => [p, `${cfg.ingestUrl}/api/ingest/llm/${p}`]))
}

/** POST JSON to the syrup app. Throws on non-2xx. */
export async function ingest<T = unknown>(cfg: SidecarConfig, path: string, body: unknown, init: { method?: string } = {}): Promise<T> {
  const res = await fetch(`${cfg.ingestUrl}${path}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.ingestToken}` },
    body: init.method === "GET" ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`ingest ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json().catch(() => ({}))) as T
}

/** Key metadata from SYRUP_ROUTER_KEYS or the app, keeping only well-formed entries. Anything else in an entry is ignored. */
export function parseKeyMeta(v: unknown): KeyMeta {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("key metadata: not an object")
  const out: KeyMeta = {}
  for (const [p, k] of Object.entries(v as Record<string, { id?: unknown; tier?: unknown }>)) {
    if (typeof k?.id === "string" && k.id && (k.tier === "free" || k.tier === "paid")) out[p] = { id: k.id, tier: k.tier }
  }
  return out
}

function sameMeta(a: KeyMeta, b: KeyMeta): boolean {
  const pa = Object.keys(a)
  if (pa.length !== Object.keys(b).length) return false
  return pa.every((p) => b[p] && b[p].id === a[p].id && b[p].tier === a[p].tier)
}

export type HttpRouterStoreOptions = {
  /** How often to re-read the user's key metadata from the syrup app. */
  keysRefreshMs?: number
  /** Least time between refreshes triggered by a rejected key. */
  authRefreshGapMs?: number
}

export class HttpRouterStore implements RouterStore {
  private catalogCache: { at: number; value: Catalog } | undefined
  private meta: KeyMeta
  private refreshing: Promise<void> | null = null
  private lastAuthRefresh = 0
  private authRefreshGapMs: number

  constructor(
    private cfg: SidecarConfig,
    private log: Log,
    opts: HttpRouterStoreOptions = {},
  ) {
    this.meta = cfg.keyMeta
    this.authRefreshGapMs = opts.authRefreshGapMs ?? 5_000
    setInterval(() => void this.refreshKeys("interval"), opts.keysRefreshMs ?? 60_000).unref()
  }

  /**
   * One entry per routable provider the user has a key for. The id and tier are
   * the real key's (health, cooldowns and events stay per key); the secret is
   * the ingest token, which is what the relay expects as the bearer.
   */
  async activeKeys(): Promise<Map<string, ActiveKey>> {
    const out = new Map<string, ActiveKey>()
    for (const [providerId, k] of Object.entries(this.meta)) {
      if (Object.hasOwn(BASE_URL, providerId)) out.set(providerId, { id: k.id, secret: this.cfg.ingestToken, tier: k.tier })
    }
    return out
  }

  /** The key id the router currently believes is active for a provider. */
  keyId(providerId: string): string | undefined {
    return Object.hasOwn(this.meta, providerId) ? this.meta[providerId].id : undefined
  }

  /**
   * Re-reads the user's key metadata, so a key added, switched or removed in
   * Settings reaches this running sandbox (local mode reads its vault on every
   * request). Concurrent calls share one fetch; failures keep the current list.
   * "hint": the relay answered with a key id other than the one on record.
   */
  refreshKeys(why: "interval" | "auth" | "hint"): Promise<void> {
    this.refreshing ??= this.fetchKeys(why).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async fetchKeys(why: string) {
    try {
      const r = await ingest<{ keys?: unknown }>(this.cfg, "/api/ingest/router/keys", undefined, { method: "GET" })
      const next = parseKeyMeta(r.keys)
      if (sameMeta(next, this.meta)) return
      this.meta = next
      this.log("router", "keys.refreshed", { why, providers: Object.keys(next).sort() })
    } catch (err) {
      this.log("router", "keys.refresh_failed", { why, message: err instanceof Error ? err.message : String(err) }, { level: "warn" })
    }
  }

  /** models.dev catalog through the OpenCode running next to us. */
  async catalog(): Promise<Catalog> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 10 * 60_000) return this.catalogCache.value
    const res = await fetch(`${this.cfg.engineUrl}/provider`, { headers: { authorization: this.cfg.engineAuth }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`engine /provider → ${res.status}`)
    const data = (await res.json()) as { all?: { id: string; models: Record<string, unknown> }[] }
    const byProvider = catalogFrom(data.all ?? [])
    this.catalogCache = { at: Date.now(), value: byProvider }
    return byProvider
  }

  /** What this user's other sandboxes (and this one before a restart) learned lately, so routing starts informed. */
  async recent(sinceMs: number): Promise<RouterEvent[]> {
    try {
      const r = await ingest<{ events?: RouterEvent[] }>(this.cfg, `/api/ingest/router/recent?since=${Math.round(sinceMs)}`, undefined, { method: "GET" })
      return Array.isArray(r.events) ? r.events : []
    } catch (err) {
      this.log("router", "recent.failed", { message: err instanceof Error ? err.message : String(err) }, { level: "warn" })
      return []
    }
  }

  async record(e: RouterEvent): Promise<void> {
    // A rejected key is the moment the user is most likely to have just replaced it.
    if (e.reason === "auth" && Date.now() - this.lastAuthRefresh >= this.authRefreshGapMs) {
      this.lastAuthRefresh = Date.now()
      void this.refreshKeys("auth")
    }
    try {
      await ingest(this.cfg, "/api/ingest/router", { events: [e] })
    } catch (err) {
      this.log("router", "ledger.write_failed", err, { level: "warn" })
    }
  }
}

export class HttpMemoryStore implements MemoryStore {
  constructor(private cfg: SidecarConfig) {}
  private call<T>(op: string, body: unknown) {
    return ingest<T>(this.cfg, `/api/ingest/memory/${op}`, body)
  }
  search(query: string, limit: number) {
    return this.call<MemoryRecord[]>("search", { query, limit })
  }
  list(limit: number) {
    return this.call<MemoryRecord[]>("list", { limit })
  }
  async get(id: string) {
    return (await this.call<MemoryRecord | null>("get", { id })) ?? undefined
  }
  save(input: { title: string; content: string; kind?: string; tags?: string[] }) {
    return this.call<MemoryRecord>("save", input)
  }
  async update(id: string, patch: { title?: string; content?: string; kind?: string; tags?: string[] }) {
    return (await this.call<MemoryRecord | null>("update", { id, ...patch })) ?? undefined
  }
  async delete(id: string) {
    await this.call("delete", { id })
  }
  /** A stamp that changes whenever the user's memories do. Cheap: one indexed aggregate on the app side. */
  async version() {
    const r = await ingest<{ version?: unknown }>(this.cfg, "/api/ingest/memory/version", undefined, { method: "GET" })
    if (typeof r.version !== "string") throw new Error("memory version: bad response")
    return r.version
  }
}
