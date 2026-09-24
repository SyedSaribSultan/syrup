import { z } from "zod"
import { handler, requireUser } from "@/server/cloud/session"
import { deleteWorkspace, getWorkspace, renameWorkspace } from "@/server/cloud/workspaces"
import { destroyWorkspaceSandbox } from "@/server/engine/sandbox"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const me = await requireUser()
  const { id } = await ctx.params
  const ws = await getWorkspace(me.id, id)
  if (!ws) return Response.json({ error: "not found" }, { status: 404 })
  const { sandbox, ...rest } = ws
  return Response.json({ workspace: { ...rest, sandbox: sandbox ? { status: sandbox.status, lastError: sandbox.lastError, engineVersion: sandbox.engineVersion, totalSessionSeconds: sandbox.totalSessionSeconds, totalCpuMs: sandbox.totalCpuMs } : null } })
})

const Patch = z.object({ name: z.string().trim().min(1).max(80) })

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const me = await requireUser()
  const { id } = await ctx.params
  const parsed = Patch.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "name required" }, { status: 400 })
  await renameWorkspace(me.id, id, parsed.data.name)
  return Response.json({ ok: true })
})

/** Destroys the sandbox and its snapshots, then soft-deletes the workspace. */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const me = await requireUser()
  const { id } = await ctx.params
  await destroyWorkspaceSandbox(me.id, id)
  await deleteWorkspace(me.id, id)
  return Response.json({ ok: true })
})
