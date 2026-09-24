import { handler, requireUser } from "@/server/cloud/session"
import { heartbeat } from "@/server/engine/sandbox"

export const dynamic = "force-dynamic"

/** Called every minute by an open workspace tab; keeps the sandbox from idle-stopping. */
export const POST = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await requireUser()
  const { id } = await ctx.params
  return Response.json(await heartbeat(me.id, id))
})
