import { z } from "zod"
import { track } from "@/server/analytics"
import { handler, requireUser } from "@/server/cloud/session"
import { createWorkspace, listWorkspaces } from "@/server/cloud/workspaces"

export const dynamic = "force-dynamic"

export const GET = handler(async () => {
  const me = await requireUser()
  const rows = await listWorkspaces(me.id)
  return Response.json({
    workspaces: rows.map((w) => ({
      id: w.id,
      name: w.name,
      source: w.source,
      repoUrl: w.repoUrl,
      createdAt: w.createdAt,
      lastOpenedAt: w.lastOpenedAt,
      sandbox: w.sandbox ? { status: w.sandbox.status, lastError: w.sandbox.lastError, totalSessionSeconds: w.sandbox.totalSessionSeconds, engineVersion: w.sandbox.engineVersion } : null,
    })),
  })
})

const Body = z.object({ name: z.string().trim().max(80).optional(), repoUrl: z.string().trim().max(300).optional() })

export const POST = handler(async (req: Request) => {
  const me = await requireUser()
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 })
  const ws = await createWorkspace(me.id, parsed.data)
  await track(me.id, "workspace_created", { source: ws.source })
  return Response.json({ workspace: ws })
})
