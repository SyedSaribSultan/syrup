import { requireUser } from "./cloud/session"
import { env } from "./env"
import type { Owner } from "./shares"

/**
 * Who is managing shares in this request. Local mode has one owner (the
 * proxy already limits /api/* to loopback, same-origin requests); the cloud
 * requires a signed-in user and scopes everything to them through RLS.
 */
export async function currentOwner(): Promise<Owner> {
  if (!env.isCloud) return { mode: "local" }
  const me = await requireUser()
  return { mode: "cloud", userId: me.id, email: me.email }
}
