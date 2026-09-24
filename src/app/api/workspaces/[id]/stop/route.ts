import { handler, requireUser } from "@/server/cloud/session"
import { stopWorkspace } from "@/server/engine/sandbox"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/** Stops the sandbox now (its filesystem is snapshotted). The next open resumes it. */
export const POST = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await requireUser()
  const { id } = await ctx.params
  return Response.json({ stopped: await stopWorkspace(me.id, id) })
})
