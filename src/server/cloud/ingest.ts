import crypto from "node:crypto"
import { env } from "../env"

/**
 * Tokens the sandbox sidecar presents to /api/ingest. HMAC-SHA256 over a
 * small JSON claim set, signed with the master key; short-lived, bound to one
 * user + workspace, so a leaked token cannot write anywhere else or for long.
 */

export type IngestClaims = { u: string; w: string; exp: number }

function key(): Buffer {
  if (!env.masterKey) throw new Error("SYRUP_MASTER_KEY is not set")
  return crypto.createHmac("sha256", Buffer.from(env.masterKey, "base64")).update("syrup-ingest-v1").digest()
}

export function mintIngestToken(userId: string, workspaceId: string, ttlMs = 2 * 60 * 60_000): string {
  const claims: IngestClaims = { u: userId, w: workspaceId, exp: Date.now() + ttlMs }
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url")
  const sig = crypto.createHmac("sha256", key()).update(body).digest("base64url")
  return `${body}.${sig}`
}

export function verifyIngestToken(token: string | null | undefined): IngestClaims | null {
  if (!token) return null
  const [body, sig] = token.split(".")
  if (!body || !sig) return null
  const expected = crypto.createHmac("sha256", key()).update(body).digest("base64url")
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as IngestClaims
    if (typeof claims.u !== "string" || typeof claims.w !== "string" || typeof claims.exp !== "number") return null
    if (claims.exp < Date.now()) return null
    return claims
  } catch {
    return null
  }
}
