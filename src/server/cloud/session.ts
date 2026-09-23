import { auth } from "@/auth"

export type Viewer = { id: string; email: string; name: string | null; admin: boolean }

/** The signed-in user, or a thrown 401 Response for route handlers to return. */
export async function requireUser(): Promise<Viewer> {
  const session = await auth()
  const u = session?.user
  if (!u?.id || !u.email) throw Response.json({ error: "sign in required" }, { status: 401 })
  return { id: u.id, email: u.email, name: u.name ?? null, admin: !!u.admin }
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
