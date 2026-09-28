import { handler } from "@/server/cloud/session"
import { currentOwner } from "@/server/share-owner"
import { debugLinkForOwner, requestOrigin } from "@/server/shares"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/**
 * A signed, expiring debug link for one of the owner's links (valid 24 hours):
 * the transcript plus router events, tool errors and logs for the chat, readable
 * without signing in while the signature holds. `?ttl=<seconds>` shortens it.
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const owner = await currentOwner()
  const { id } = await ctx.params
  const u = new URL(req.url)
  const ttl = Number(u.searchParams.get("ttl")) || undefined
  const link = await debugLinkForOwner(owner, id, requestOrigin(req), ttl)
  return Response.json(link, { headers: { "cache-control": "no-store" } })
})
