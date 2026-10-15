import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { after } from "next/server"
import { auth } from "@/auth"
import { isAdmin } from "@/auth.config"
import { pg, pgReady, pgSchema } from "../db/pg"
import { env } from "../env"
import { UserError } from "../user-error"

export { UserError }

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

/**
 * A 500 that tells the client nothing internal (audit 2026-10-15 M3): a generic sentence and a request id. The
 * details go to the server log under the same id, so a user's report can be matched to the stack.
 */
export function internalError(err: unknown, where = "api"): Response {
  const requestId = crypto.randomBytes(6).toString("hex")
  console.error(`[syrup:${where}] request ${requestId} failed:`, err)
  // after(): the report finishes once the response is sent, before the function is frozen.
  const report = () => import("../analytics").then((a) => a.reportServerError(err, { requestId, where }))
  try {
    after(report)
  } catch {
    void report()
  }
  return Response.json({ error: `Something went wrong on our side. Reference: ${requestId}`, requestId }, { status: 500, headers: { "x-request-id": requestId } })
}

/** Route-handler wrapper: thrown Responses and UserErrors become responses, anything else a generic 500 with a request id. */
export function handler<A extends unknown[]>(fn: (...a: A) => Promise<Response>) {
  return async (...a: A): Promise<Response> => {
    try {
      return await fn(...a)
    } catch (err) {
      if (err instanceof Response) return err
      if (err instanceof UserError) return Response.json({ error: err.message }, { status: err.status })
      return internalError(err)
    }
  }
}
