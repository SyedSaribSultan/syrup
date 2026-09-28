import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { auth } from "@/auth"
import { isAdmin } from "@/auth.config"
import { pg, pgReady, pgSchema } from "../db/pg"
import { env } from "../env"

export type Viewer = { id: string; email: string; name: string | null; admin: boolean }

/**
 * Scripted admin access: `Authorization: Bearer <SYRUP_OPS_TOKEN>` acts as the
 * first admin account. Used for smoke tests and probes from the CLI; the token
 * lives only in Vercel env.
 */
async function opsViewer(): Promise<Viewer | null> {
  const token = process.env.SYRUP_OPS_TOKEN
  if (!token) return null
  const { headers } = await import("next/headers")
  const h = (await headers()).get("authorization") ?? ""
  const given = h.startsWith("Bearer ") ? h.slice(7) : ""
  if (!given || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return null
  const email = env.adminEmails[0]
  if (!email) return null
  await pgReady()
  const [u] = await pg().select({ id: pgSchema.users.id, name: pgSchema.users.name }).from(pgSchema.users).where(eq(pgSchema.users.email, email))
  return u ? { id: u.id, email, name: u.name, admin: true } : null
}

// Blocked accounts (users.blocked_at). Sessions are JWTs, so the check is a DB read, cached per instance for a minute.
const BLOCK_TTL_MS = 60_000
const blockCache = new Map<string, { blocked: boolean; at: number }>()

async function isBlocked(userId: string): Promise<boolean> {
  const hit = blockCache.get(userId)
  if (hit && Date.now() - hit.at < BLOCK_TTL_MS) return hit.blocked
  await pgReady()
  const [u] = await pg().select({ blockedAt: pgSchema.users.blockedAt }).from(pgSchema.users).where(eq(pgSchema.users.id, userId))
  const blocked = !!u?.blockedAt
  blockCache.set(userId, { blocked, at: Date.now() })
  return blocked
}

/** Forget the cached answer so a block or unblock applies at once on this instance (others catch up within a minute). */
export function forgetBlocked(userId: string) {
  blockCache.delete(userId)
}

/** The signed-in user, or a thrown 401 Response for route handlers to return. Blocked accounts get a 403. */
export async function requireUser(): Promise<Viewer> {
  const session = await auth()
  const u = session?.user
  if (u?.id && u.email) {
    if (await isBlocked(u.id)) throw Response.json({ error: "this account is suspended" }, { status: 403 })
    return { id: u.id, email: u.email, name: u.name ?? null, admin: !!u.admin || isAdmin(u.email) }
  }
  const ops = await opsViewer()
  if (ops) return ops
  throw Response.json({ error: "sign in required" }, { status: 401 })
}

export async function requireAdmin(): Promise<Viewer> {
  const v = await requireUser()
  if (!v.admin) throw Response.json({ error: "admin only" }, { status: 403 })
  return v
}

/** Route-handler wrapper: turns thrown Responses into responses and other errors into 500s. */
export function handler<A extends unknown[]>(fn: (...a: A) => Promise<Response>) {
  return async (...a: A): Promise<Response> => {
    try {
      return await fn(...a)
    } catch (err) {
      if (err instanceof Response) return err
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }
}
