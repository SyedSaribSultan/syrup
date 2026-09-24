import { z } from "zod"
import { track } from "@/server/analytics"
import { clearGithubToken, githubTokenHint, saveGithubToken } from "@/server/cloud/github"
import { handler, requireUser } from "@/server/cloud/session"

export const dynamic = "force-dynamic"

export const GET = handler(async () => {
  const me = await requireUser()
  const hint = await githubTokenHint(me.id)
  return Response.json({ connected: !!hint, hint })
})

export const PUT = handler(async (req: Request) => {
  const me = await requireUser()
  const parsed = z.object({ token: z.string().min(20).max(400) }).safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "token required" }, { status: 400 })
  const r = await saveGithubToken(me.id, parsed.data.token)
  await track(me.id, "github_connected")
  return Response.json({ connected: true, hint: r.hint })
})

export const DELETE = handler(async () => {
  const me = await requireUser()
  await clearGithubToken(me.id)
  return Response.json({ connected: false })
})
