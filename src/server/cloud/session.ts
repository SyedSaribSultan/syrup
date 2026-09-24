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

/** The signed-in user, or a thrown 401 Response for route handlers to return. */
export async function requireUser(): Promise<Viewer> {
  const session = await auth()
  const u = session?.user
  if (u?.id && u.email) return { id: u.id, email: u.email, name: u.name ?? null, admin: !!u.admin || isAdmin(u.email) }
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
