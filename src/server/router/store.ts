/**
 * What the router needs from its surroundings. Two implementations:
 * - store-local.ts: SQLite vault + the local OpenCode's model catalog (local mode).
 * - sidecar/store-http.ts: key metadata from process env (refreshed from /api/ingest/router/keys) + the sandbox
 *   OpenCode's catalog, events posted to /api/ingest (cloud mode, inside the sandbox). No provider secret is there:
 *   each ActiveKey carries the real key's id and tier, and the ingest token as its secret, because the router's
 *   base URLs point at the app's LLM relay (/api/ingest/llm/<provider>), which swaps in the real key per call.
 */

import type { ModelLike } from "../../lib/model-registry"

export type Tier = "free" | "paid"

/** `secret` is what the router sends as the bearer: the provider key locally, the ingest token in the cloud sidecar. */
export type ActiveKey = { id: string | null; secret: string; tier: Tier }

/**
 * One catalog entry. OpenCode's provider list returns the `capabilities`
 * shape (capabilities.toolcall, capabilities.interleaved, …); raw models.dev
 * uses flat fields (tool_call, interleaved, modalities). Both stores normalise
 * into `capabilities` (catalog.ts), and the legacy fields stay optional here.
 */
export type CatalogModel = ModelLike & {
  attachment?: boolean
  reasoning?: boolean
  interleaved?: boolean | { field?: string }
  modalities?: { input?: string[]; output?: string[] }
  /** Per-model SDK override (models.dev); OpenCode's shape carries it as api.npm. */
  provider?: { npm?: string; api?: string }
  api?: { id?: string; url?: string; npm?: string }
  variants?: unknown
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
  /** OpenCode session (x-session-affinity header). */
  sessionId: string | null
  /** Send → first content token, ms. Null when no content arrived. */
  ttftMs: number | null
  /** Epoch ms until which this backend is skipped after this event. Null when not cooling down. */
  retryAt: number | null
  /** Why chosen (sticky, best, escalated, fallback) or how it failed (rpd, rpm, overloaded, auth, context, timeout, bad_request, network). */
  reason: string | null
}

export interface RouterStore {
  /** Active key per routable provider. */
  activeKeys(): Promise<Map<string, ActiveKey>>
  /** Model catalog with prices and limits (models.dev via OpenCode). May be cached. */
  catalog(): Promise<Catalog>
  /** Persist one routing attempt. Must never throw. */
  record(event: RouterEvent): Promise<void>
  /**
   * Attempts recorded since `sinceMs` (epoch), oldest first, by any router process for this user's keys.
   * A fresh router replays them into its health memory, so a sandbox start or an app restart does not begin
   * by trying models that were overloaded a minute ago. Optional; must never throw.
   */
  recent?(sinceMs: number): Promise<RouterEvent[]>
}
