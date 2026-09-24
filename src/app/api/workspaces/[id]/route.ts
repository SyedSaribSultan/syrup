import { z } from "zod"
import { handler, requireUser } from "@/server/cloud/session"
import { deleteWorkspace, getWorkspace, renameWorkspace, setEgress } from "@/server/cloud/workspaces"
import { normalizeHosts } from "@/server/engine/egress"
import { applyEgress, destroyWorkspaceSandbox } from "@/server/engine/sandbox"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const me = await requireUser()
  const { id } = await ctx.params
  const ws = await getWorkspace(me.id, id)
  if (!ws) return Response.json({ error: "not found" }, { status: 404 })
  const { sandbox, ...rest } = ws
  return Response.json({ workspace: { ...rest, egressAllow: rest.egressAllow, sandbox: sandbox ? { status: sandbox.status, lastError: sandbox.lastError, engineVersion: sandbox.engineVersion, totalSessionSeconds: sandbox.totalSessionSeconds, totalCpuMs: sandbox.totalCpuMs } : null } })
})

const Patch = z.object({ name: z.string().trim().min(1).max(80).optional(), egressAllow: z.array(z.string().max(253)).max(50).optional() })

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const me = await requireUser()
  const { id } = await ctx.params
  const parsed = Patch.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 })
  if (parsed.data.name) await renameWorkspace(me.id, id, parsed.data.name)
  if (parsed.data.egressAllow) {
    const hosts = normalizeHosts(parsed.data.egressAllow)
    await setEgress(me.id, id, hosts)
    await applyEgress(me.id, id)
    return Response.json({ ok: true, egressAllow: hosts })
  }
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
