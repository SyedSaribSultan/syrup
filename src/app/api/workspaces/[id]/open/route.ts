import { handler, requireUser } from "@/server/cloud/session"
import { openWorkspace } from "@/server/engine/sandbox"

export const dynamic = "force-dynamic"
// Cold start (installer + clone) can take a minute; Hobby allows up to 300 s.
export const maxDuration = 180

/** Boots or wakes the workspace's sandbox and returns how the browser should connect to OpenCode inside it. */
export const POST = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await requireUser()
  const { id } = await ctx.params
  // Kill switch: pause every agent start without a deploy.
  if (process.env.SYRUP_AGENT_ENABLED === "0") return Response.json({ error: "syrup's agent is paused for maintenance. Back shortly." }, { status: 503 })
  const conn = await openWorkspace(me.id, id)
  return Response.json({ connection: conn })
})
