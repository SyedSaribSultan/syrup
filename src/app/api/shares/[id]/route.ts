import { handler } from "@/server/cloud/session"
import { currentOwner } from "@/server/share-owner"
import { revokeShare, updateShare, requestOrigin } from "@/server/shares"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Update link: re-snapshot the chat now. The URL stays the same. */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const owner = await currentOwner()
  const { id } = await ctx.params
  const share = await updateShare(owner, id, requestOrigin(req))
  return Response.json({ share })
})

/** Stop sharing: the link 404s from the next request on, cached copies included. */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const owner = await currentOwner()
  const { id } = await ctx.params
  await revokeShare(owner, id)
  return Response.json({ ok: true })
})
