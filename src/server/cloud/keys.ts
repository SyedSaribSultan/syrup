import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { after } from "next/server"
import { ulid } from "ulid"
import { KeyCache, type RelayKeyInfo, type RelayLookup, type RelaySession, type RelaySnapshot } from "../../app/api/ingest/llm/relay"
import { pg, pgReady, pgSchema, withUser } from "../db/pg"
import { slog } from "../log"
import { BUILT_IN, CURATED, isRoutable, type KeyInfo, type ProviderInfo, type Tier } from "../providers"
import { audit } from "./audit"
import { hint, openWith, sealWith, userDek } from "./crypto"

/**
 * Provider keys in cloud mode: per user, envelope-encrypted, never written
 * anywhere but Postgres. Plaintext leaves this module only for the LLM relay
 * (/api/ingest/llm, relayLookup below), which calls the provider from the app.
 * The sandbox sidecar gets key metadata only (activeKeyMeta): no secrets ever
 * enter the sandbox.
 */

const NAMES: Record<string, string> = {
  google: "Google AI Studio",
  nvidia: "NVIDIA NIM",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  zai: "Z.ai",
  cohere: "Cohere",
  groq: "Groq",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  openai: "OpenAI",
  huggingface: "Hugging Face",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
}

function toInfo(r: typeof pgSchema.providerKeys.$inferSelect): KeyInfo {
  return { id: r.id, label: r.label, tier: r.tier, hint: r.hint, active: r.active, createdAt: r.createdAt.getTime() }
}

export async function listProviders(userId: string): Promise<{ providers: ProviderInfo[]; default: Record<string, string> }> {
  const rows = await withUser(userId, (tx) => tx.select().from(pgSchema.providerKeys).where(eq(pgSchema.providerKeys.userId, userId)).orderBy(desc(pgSchema.providerKeys.createdAt)))
  const keysBy = new Map<string, KeyInfo[]>()
  for (const r of rows) keysBy.set(r.providerId, [...(keysBy.get(r.providerId) ?? []), toInfo(r)])
  // Cloud has no engine catalog here: the list is the curated providers plus any with a stored key.
  // Built-in providers (router, OpenCode Zen) never take a key, so they are never listed.
  const ids = new Set([...Object.keys(CURATED), ...keysBy.keys()].filter((id) => !BUILT_IN.has(id)))
  const providers: ProviderInfo[] = [...ids].map((id) => ({
    id,
    name: NAMES[id] ?? id,
    connected: (keysBy.get(id)?.length ?? 0) > 0,
    routable: isRoutable(id),
    env: [],
    keys: keysBy.get(id) ?? [],
    curated: CURATED[id],
  }))
  return { providers, default: {} }
}

export async function addKey(userId: string, providerId: string, key: string, label: string, tier: Tier): Promise<KeyInfo> {
  if (BUILT_IN.has(providerId)) throw new Error(`${providerId} is built in and does not take a key`)
  const info = await withUser(userId, async (tx) => {
    const dek = await userDek(tx, userId)
    const id = ulid()
    await tx.update(pgSchema.providerKeys).set({ active: false }).where(and(eq(pgSchema.providerKeys.userId, userId), eq(pgSchema.providerKeys.providerId, providerId)))
    const [row] = await tx
      .insert(pgSchema.providerKeys)
      .values({ id, userId, providerId, label: label || `${providerId} key`, secretEnc: sealWith(dek, key), hint: hint(key), tier, enabled: true, active: true })
      .returning()
    await audit(tx, { userId, actor: "user", action: "provider_key.add", target: id, data: { providerId, tier, hint: hint(key) } })
    return toInfo(row)
  })
  forgetRelayKeys(userId)
  return info
}

export async function activateKey(userId: string, providerId: string, keyId: string): Promise<void> {
  await withUser(userId, async (tx) => {
    const [row] = await tx.select().from(pgSchema.providerKeys).where(and(eq(pgSchema.providerKeys.id, keyId), eq(pgSchema.providerKeys.providerId, providerId)))
    if (!row) throw new Error("key not found")
    await tx.update(pgSchema.providerKeys).set({ active: false }).where(and(eq(pgSchema.providerKeys.userId, userId), eq(pgSchema.providerKeys.providerId, providerId)))
    await tx.update(pgSchema.providerKeys).set({ active: true }).where(eq(pgSchema.providerKeys.id, keyId))
    await audit(tx, { userId, actor: "user", action: "provider_key.activate", target: keyId, data: { providerId } })
  })
  forgetRelayKeys(userId)
}

export async function removeKey(userId: string, providerId: string, keyId: string): Promise<void> {
  await withUser(userId, async (tx) => {
    const [row] = await tx.select().from(pgSchema.providerKeys).where(and(eq(pgSchema.providerKeys.id, keyId), eq(pgSchema.providerKeys.providerId, providerId)))
    if (!row) return
    await tx.delete(pgSchema.providerKeys).where(eq(pgSchema.providerKeys.id, keyId))
    if (row.active) {
      const [next] = await tx.select().from(pgSchema.providerKeys).where(and(eq(pgSchema.providerKeys.userId, userId), eq(pgSchema.providerKeys.providerId, providerId))).orderBy(desc(pgSchema.providerKeys.createdAt)).limit(1)
      if (next) await tx.update(pgSchema.providerKeys).set({ active: true }).where(eq(pgSchema.providerKeys.id, next.id))
    }
    await audit(tx, { userId, actor: "user", action: "provider_key.remove", target: keyId, data: { providerId } })
  })
  forgetRelayKeys(userId)
}

export type KeyMeta = { id: string; tier: Tier }

/**
 * Active, enabled key per provider: id and tier only, nothing decrypted. This
 * is all the sandbox sidecar learns about keys (SYRUP_ROUTER_KEYS at start,
 * then GET /api/ingest/router/keys).
 */
export async function activeKeyMeta(userId: string): Promise<Record<string, KeyMeta>> {
  const k = pgSchema.providerKeys
  const rows = await withUser(userId, (tx) =>
    tx
      .select({ providerId: k.providerId, id: k.id, tier: k.tier })
      .from(k)
      .where(and(eq(k.userId, userId), eq(k.active, true), eq(k.enabled, true))),
  )
  const out: Record<string, KeyMeta> = {}
  for (const r of rows) out[r.providerId] = { id: r.id, tier: r.tier }
  return out
}

/**
 * Everything the relay needs about one user, in one transaction: every active
 * key decrypted (a failover or hedge to another provider then finds it cached)
 * and each live workspace's sandbox session (the ingest token is bound to one).
 *
 * It does not wait for migrations: on a fresh instance that would put a second
 * database connection and five round trips on the first token, for work that
 * deploys and every other route already do. They start in the background here.
 */
async function loadRelaySnapshot(userId: string): Promise<RelaySnapshot> {
  void pgReady().catch(() => {})
  const k = pgSchema.providerKeys
  const sb = pgSchema.sandboxes
  const ws = pgSchema.workspaces
  return pg().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    const [rows, boxes] = await Promise.all([
      tx
        .select({ providerId: k.providerId, id: k.id, tier: k.tier, secretEnc: k.secretEnc })
        .from(k)
        .where(and(eq(k.userId, userId), eq(k.active, true), eq(k.enabled, true))),
      tx
        .select({ workspaceId: sb.workspaceId, status: sb.status, startedAt: sb.lastSessionStartedAt })
        .from(sb)
        .innerJoin(ws, eq(ws.id, sb.workspaceId))
        .where(and(eq(sb.userId, userId), isNull(ws.deletedAt))),
    ])
    const keys = new Map<string, RelayKeyInfo>()
    if (rows.length > 0) {
      const dek = await userDek(tx, userId)
      for (const r of rows) keys.set(r.providerId, { id: r.id, secret: openWith(dek, r.secretEnc), tier: r.tier })
    }
    const sessions = new Map<string, RelaySession>()
    for (const b of boxes) sessions.set(b.workspaceId, { startedAt: b.startedAt?.getTime() ?? null, live: b.status === "starting" || b.status === "running" })
    return { keys, sessions }
  })
}

/**
 * One cache per Node instance, on globalThis because Next bundles this module
 * into several routes (Settings writes, the relay reads). Fluid compute shares
 * an instance across invocations, so warm relay calls do no database work:
 * fresh for 10 s, then served at once while one background read refreshes it,
 * for up to an hour (an ingest token's life). A failed refresh is ridden out
 * for a minute, then calls wait for the database again. Each read gives up
 * after 4 s. Keys switched or removed on another instance are caught by the
 * sidecar's expected key id (relay.ts), not by this cache's age.
 */
const g = globalThis as unknown as { __syrupRelayKeys?: KeyCache<RelaySnapshot> }
function relayKeys(): KeyCache<RelaySnapshot> {
  return (g.__syrupRelayKeys ??= new KeyCache(loadRelaySnapshot, {
    freshMs: 10_000,
    maxAgeMs: 60 * 60_000,
    failGraceMs: 60_000,
    loadTimeoutMs: 4_000,
    reloadGapMs: 1_000,
    maxUsers: 1_000,
    onError: (_userId, err) => slog("router", "relay.key_refresh_failed", { message: err instanceof Error ? err.message : String(err) }, { level: "warn" }),
    background: (work) => {
      try {
        // Keeps the instance alive until a background refresh finishes, even after a short answer (GET models).
        after(() => work)
      } catch {
        // Outside a request: nothing to keep alive.
      }
    },
  }))
}

/** The user's keys (decrypted) and sandbox sessions, for the LLM relay only. */
export function relayLookup(userId: string, opts: { reload?: boolean } = {}): Promise<RelayLookup> {
  return opts.reload ? relayKeys().reload(userId) : relayKeys().get(userId)
}

/** After a key is added, switched or removed: this instance's relay reads the database on its next call. Other instances re-read when the sidecar's expected key id differs from theirs. */
export function forgetRelayKeys(userId: string): void {
  g.__syrupRelayKeys?.forget(userId)
}
