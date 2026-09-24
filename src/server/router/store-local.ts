import { eq } from "drizzle-orm"
import { db, dbReady, schema } from "../db"
import { engine } from "../engine/opencode"
import { slog } from "../log"
import { open } from "../vault"
import { BASE_URL, ENV_NAMES } from "./backends"
import type { ActiveKey, Catalog, CatalogModel, RouterEvent, RouterStore } from "./store"

/** Local mode: keys from the SQLite vault (then env), catalog from the local OpenCode, events into SQLite. */
export class LocalRouterStore implements RouterStore {
  private catalogCache: { at: number; value: Catalog } | undefined

  async activeKeys(): Promise<Map<string, ActiveKey>> {
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

  async catalog(): Promise<Catalog> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 5 * 60_000) return this.catalogCache.value
    const { client } = await engine()
    const res = await client.provider.list()
    const byProvider: Catalog = new Map()
    for (const p of res.data?.all ?? []) {
      const models = new Map<string, CatalogModel>()
      for (const m of Object.values(p.models) as CatalogModel[]) models.set(m.id, m)
      byProvider.set(p.id, models)
    }
    this.catalogCache = { at: Date.now(), value: byProvider }
    return byProvider
  }

  async record(e: RouterEvent): Promise<void> {
    try {
      await dbReady()
      await db().insert(schema.routerEvents).values(e)
    } catch (err) {
      slog("router", "ledger.write_failed", err, { level: "warn" })
    }
  }
}
