import { handler, requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { activateKey, removeKey } from "@/server/providers"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string; keyId: string }> }

/** Make this key the one the agent uses for the provider. */
export const PATCH = handler(async (_req: Request, ctx: Ctx) => {
  const { id, keyId } = await ctx.params
  if (env.isCloud) {
    const me = await requireUser()
    const cloud = await import("@/server/cloud/keys")
    await cloud.activateKey(me.id, id, keyId)
  } else {
    await activateKey(id, keyId)
  }
  return Response.json({ ok: true })
})

export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const { id, keyId } = await ctx.params
  if (env.isCloud) {
    const me = await requireUser()
    const cloud = await import("@/server/cloud/keys")
    await cloud.removeKey(me.id, id, keyId)
  } else {
    await removeKey(id, keyId)
  }
  return Response.json({ ok: true })
})
