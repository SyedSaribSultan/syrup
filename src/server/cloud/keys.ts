import { and, desc, eq } from "drizzle-orm"
import { ulid } from "ulid"
import { pgSchema, withUser } from "../db/pg"
import { CURATED, type KeyInfo, type ProviderInfo, type Tier } from "../providers"
import { audit } from "./audit"
import { hint, openWith, sealWith, userDek } from "./crypto"

/**
 * Provider keys in cloud mode: per user, envelope-encrypted, never written
 * anywhere but Postgres. The sandbox sidecar (Phase 2) receives the active
 * keys in memory at resume time.
 */

const NAMES: Record<string, string> = {
  google: "Google AI Studio",
  mistral: "Mistral",
  openrouter: "OpenRouter",
  groq: "Groq",
  nvidia: "NVIDIA NIM",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  openai: "OpenAI",
  cohere: "Cohere",
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
  const ids = new Set([...Object.keys(CURATED), ...keysBy.keys()])
  const providers: ProviderInfo[] = [...ids].map((id) => ({
    id,
    name: NAMES[id] ?? id,
    connected: (keysBy.get(id)?.length ?? 0) > 0,
    models: 0,
    freeModels: 0,
    env: [],
    keys: keysBy.get(id) ?? [],
    curated: CURATED[id],
  }))
  return { providers, default: {} }
}

export async function addKey(userId: string, providerId: string, key: string, label: string, tier: Tier): Promise<KeyInfo> {
  return withUser(userId, async (tx) => {
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
}

export async function activateKey(userId: string, providerId: string, keyId: string): Promise<void> {
  await withUser(userId, async (tx) => {
    const [row] = await tx.select().from(pgSchema.providerKeys).where(and(eq(pgSchema.providerKeys.id, keyId), eq(pgSchema.providerKeys.providerId, providerId)))
    if (!row) throw new Error("key not found")
    await tx.update(pgSchema.providerKeys).set({ active: false }).where(and(eq(pgSchema.providerKeys.userId, userId), eq(pgSchema.providerKeys.providerId, providerId)))
    await tx.update(pgSchema.providerKeys).set({ active: true }).where(eq(pgSchema.providerKeys.id, keyId))
    await audit(tx, { userId, actor: "user", action: "provider_key.activate", target: keyId, data: { providerId } })
  })
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
}

/** Plaintext of every active key. Only the sandbox launcher (Phase 2) calls this. */
export async function activeKeys(userId: string): Promise<Record<string, string>> {
  return withUser(userId, async (tx) => {
    const dek = await userDek(tx, userId)
    const rows = await tx.select().from(pgSchema.providerKeys).where(and(eq(pgSchema.providerKeys.userId, userId), eq(pgSchema.providerKeys.active, true), eq(pgSchema.providerKeys.enabled, true)))
    const out: Record<string, string> = {}
    for (const r of rows) out[r.providerId] = openWith(dek, r.secretEnc)
    return out
  })
}
