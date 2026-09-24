/**
 * What the router needs from its surroundings. Two implementations:
 * - store-local.ts: SQLite vault + the local OpenCode's model catalog (local mode).
 * - sidecar/store-http.ts: keys from process env + the sandbox OpenCode's catalog,
 *   events posted to /api/ingest (cloud mode, inside the sandbox).
 */

export type Tier = "free" | "paid"

export type ActiveKey = { id: string | null; secret: string; tier: Tier }

export type CatalogModel = {
  id: string
  cost?: { input: number; output: number }
  limit?: { context?: number; output?: number }
  tool_call?: boolean
  status?: string
}

/** provider id -> model id -> model */
export type Catalog = Map<string, Map<string, CatalogModel>>

export type RouterEvent = {
  id: string
  ts: number
  alias: string
  providerId: string
  modelId: string
  keyId: string | null
  tier: Tier
  /** "ok" | "rate_limited" | "error" | "aborted" */
  status: string
  httpStatus: number | null
  attempts: number
  latencyMs: number
  inputTokens: number
  outputTokens: number
  cost: number
  error: string | null
}

export interface RouterStore {
  /** Active key per routable provider. */
  activeKeys(): Promise<Map<string, ActiveKey>>
  /** Model catalog with prices and limits (models.dev via OpenCode). May be cached. */
  catalog(): Promise<Catalog>
  /** Persist one routing attempt. Must never throw. */
  record(event: RouterEvent): Promise<void>
}
