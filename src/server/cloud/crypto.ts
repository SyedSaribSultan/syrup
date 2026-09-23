import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { env } from "../env"
import { pgSchema, type PgTx } from "../db/pg"

/**
 * Envelope encryption (docs/PLAN.md §3.4). SYRUP_MASTER_KEY wraps one
 * data-encryption key (DEK) per user; the DEK encrypts that user's secrets.
 * Rotating the master key means rewrapping DEKs, not re-encrypting every row.
 */

function master(): Buffer {
  if (!env.masterKey) throw new Error("SYRUP_MASTER_KEY is not set")
  const k = Buffer.from(env.masterKey, "base64")
  if (k.length !== 32) throw new Error("SYRUP_MASTER_KEY must be 32 bytes, base64")
  return k
}

function encrypt(key: Buffer, plain: Buffer): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")
}

function decrypt(key: Buffer, sealed: string): Buffer {
  const buf = Buffer.from(sealed, "base64")
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()])
}

/** The user's DEK, created on first use. Must run inside withUser(). */
export async function userDek(tx: PgTx, userId: string): Promise<Buffer> {
  const [row] = await tx.select().from(pgSchema.userKeys).where(eq(pgSchema.userKeys.userId, userId))
  if (row) return decrypt(master(), row.dekWrapped)
  const dek = crypto.randomBytes(32)
  await tx.insert(pgSchema.userKeys).values({ userId, dekWrapped: encrypt(master(), dek), wrapVersion: 1 })
  return dek
}

export function sealWith(dek: Buffer, plain: string): string {
  return encrypt(dek, Buffer.from(plain, "utf8"))
}

export function openWith(dek: Buffer, sealed: string): string {
  return decrypt(dek, sealed).toString("utf8")
}

/** Last 4 characters, for display. */
export function hint(plain: string): string {
  return plain.length > 8 ? `…${plain.slice(-4)}` : "••••"
}

/** Stable, non-reversible token for an IP (audit trail without storing addresses). */
export function ipHash(ip: string | null | undefined): string | null {
  if (!ip) return null
  return crypto.createHmac("sha256", master()).update(ip).digest("base64url").slice(0, 24)
}
