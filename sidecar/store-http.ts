import type { MemoryRecord, MemoryStore } from "../src/server/memory/tools"
import { BASE_URL } from "../src/server/router/backends"
import { catalogFrom } from "../src/server/router/catalog"
import type { ActiveKey, Catalog, RouterEvent, RouterStore } from "../src/server/router/store"
import type { Log } from "../src/server/shared/log"

type SidecarKeys = Record<string, { id: string; secret: string; tier: "free" | "paid" }>

/** Everything the sidecar is told at start, all through process env. */
export type SidecarConfig = {
  port: number
  secret: string
  /** provider id -> key at start. Parsed from SYRUP_KEYS, then removed from process.env; HttpRouterStore refreshes its own copy. */
  keys: SidecarKeys
  ingestUrl: string
  ingestToken: string
  engineUrl: string
  engineAuth: string
}

export function readSidecarEnv(): SidecarConfig {
  const need = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`sidecar: ${k} is required`)
    return v
  }
  const keys = JSON.parse(need("SYRUP_KEYS")) as SidecarConfig["keys"]
  const password = need("OPENCODE_SERVER_PASSWORD")
  const cfg: SidecarConfig = {
    port: Number(process.env.SYRUP_ROUTER_PORT ?? 4210),
    secret: need("SYRUP_INTERNAL_SECRET"),
    keys,
    ingestUrl: need("SYRUP_INGEST_URL").replace(/\/$/, ""),
    ingestToken: need("SYRUP_INGEST_TOKEN"),
    engineUrl: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    engineAuth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  }
  // Keep secrets out of anything that dumps the environment later.
  delete process.env.SYRUP_KEYS
  delete process.env.SYRUP_INGEST_TOKEN
  return cfg
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

/** The keys endpoint's answer, keeping only well-formed entries. */
function parseKeys(v: unknown): SidecarKeys {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("keys: not an object")
  const out: SidecarKeys = {}
  for (const [p, k] of Object.entries(v as Record<string, { id?: unknown; secret?: unknown; tier?: unknown }>)) {
    if (typeof k?.id === "string" && typeof k.secret === "string" && k.secret && (k.tier === "free" || k.tier === "paid")) out[p] = { id: k.id, secret: k.secret, tier: k.tier }
  }
  return out
}

function sameKeys(a: SidecarKeys, b: SidecarKeys): boolean {
  const pa = Object.keys(a)
  if (pa.length !== Object.keys(b).length) return false
  return pa.every((p) => b[p] && b[p].id === a[p].id && b[p].secret === a[p].secret && b[p].tier === a[p].tier)
}

export type HttpRouterStoreOptions = {
  /** How often to re-read the user's keys from the syrup app. */
  keysRefreshMs?: number
  /** Least time between refreshes triggered by a rejected key. */
  authRefreshGapMs?: number
}

export class HttpRouterStore implements RouterStore {
  private catalogCache: { at: number; value: Catalog } | undefined
  private keys: SidecarKeys
  private refreshing: Promise<void> | null = null
  private lastAuthRefresh = 0
  private authRefreshGapMs: number

  constructor(
    private cfg: SidecarConfig,
    private log: Log,
    opts: HttpRouterStoreOptions = {},
  ) {
    this.keys = cfg.keys
    this.authRefreshGapMs = opts.authRefreshGapMs ?? 5_000
    setInterval(() => void this.refreshKeys("interval"), opts.keysRefreshMs ?? 60_000).unref()
  }

  async activeKeys(): Promise<Map<string, ActiveKey>> {
    const out = new Map<string, ActiveKey>()
    for (const [providerId, k] of Object.entries(this.keys)) {
      if (BASE_URL[providerId]) out.set(providerId, { id: k.id, secret: k.secret, tier: k.tier })
    }
    return out
  }

  /**
   * Re-reads the user's active keys, so a key added, switched or removed in
   * Settings reaches this running sandbox (local mode reads its vault on every
   * request). Concurrent calls share one fetch; failures keep the current keys.
   */
  refreshKeys(why: "interval" | "auth"): Promise<void> {
    this.refreshing ??= this.fetchKeys(why).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async fetchKeys(why: string) {
    try {
      const have = Object.keys(this.keys).sort().join(",")
      const next = parseKeys(await ingest<unknown>(this.cfg, `/api/ingest/keys?have=${encodeURIComponent(have)}`, undefined, { method: "GET" }))
      if (sameKeys(next, this.keys)) return
      this.keys = next
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
