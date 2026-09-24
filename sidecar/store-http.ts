import type { MemoryRecord, MemoryStore } from "../src/server/memory/tools"
import { BASE_URL } from "../src/server/router/backends"
import type { ActiveKey, Catalog, CatalogModel, RouterEvent, RouterStore } from "../src/server/router/store"
import type { Log } from "../src/server/shared/log"

/** Everything the sidecar is told at start, all through process env. */
export type SidecarConfig = {
  port: number
  secret: string
  /** provider id -> key. Parsed from SYRUP_KEYS, then removed from process.env. */
  keys: Record<string, { id: string; secret: string; tier: "free" | "paid" }>
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

export class HttpRouterStore implements RouterStore {
  private catalogCache: { at: number; value: Catalog } | undefined
  constructor(
    private cfg: SidecarConfig,
    private log: Log,
  ) {}

  async activeKeys(): Promise<Map<string, ActiveKey>> {
    const out = new Map<string, ActiveKey>()
    for (const [providerId, k] of Object.entries(this.cfg.keys)) {
      if (BASE_URL[providerId]) out.set(providerId, { id: k.id, secret: k.secret, tier: k.tier })
    }
    return out
  }

  /** models.dev catalog through the OpenCode running next to us. */
  async catalog(): Promise<Catalog> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 10 * 60_000) return this.catalogCache.value
    const res = await fetch(`${this.cfg.engineUrl}/provider`, { headers: { authorization: this.cfg.engineAuth }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`engine /provider → ${res.status}`)
    const data = (await res.json()) as { all?: { id: string; models: Record<string, CatalogModel> }[] }
    const byProvider: Catalog = new Map()
    for (const p of data.all ?? []) {
      const models = new Map<string, CatalogModel>()
      for (const m of Object.values(p.models)) models.set(m.id, m)
      byProvider.set(p.id, models)
    }
    this.catalogCache = { at: Date.now(), value: byProvider }
    return byProvider
  }

  async record(e: RouterEvent): Promise<void> {
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
}
