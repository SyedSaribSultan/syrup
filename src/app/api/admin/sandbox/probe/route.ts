import { z } from "zod"
import { handler, requireAdmin } from "@/server/cloud/session"
import { createWorkspace, deleteWorkspace, getWorkspace } from "@/server/cloud/workspaces"
import { destroyWorkspaceSandbox, openWorkspace, stopWorkspace } from "@/server/engine/sandbox"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Body = z.object({
  /** Existing workspace to probe; otherwise a temporary one is created from repoUrl (or empty). */
  workspaceId: z.string().optional(),
  repoUrl: z.string().optional(),
  /** Keep the sandbox running afterwards (default: stop it to save quota). */
  keep: z.boolean().default(false),
  /** Delete the temporary workspace afterwards (default true when one was created). */
  cleanup: z.boolean().optional(),
})

/**
 * Admin-only end-to-end check of the sandbox path (docs/PHASE2.md S1 gate):
 * boots or wakes a sandbox, verifies OpenCode answers with the password,
 * reports timings, and stops it.
 */
export const POST = handler(async (req: Request) => {
  const me = await requireAdmin()
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 })
  let workspaceId = parsed.data.workspaceId
  let temporary = false
  if (!workspaceId) {
    const ws = await createWorkspace(me.id, { name: "probe", repoUrl: parsed.data.repoUrl })
    workspaceId = ws.id
    temporary = true
  }
  const t0 = Date.now()
  const conn = await openWorkspace(me.id, workspaceId)
  const health = await fetch(`${conn.baseUrl}/global/health`, { headers: { authorization: conn.authorization }, cache: "no-store" }).then((r) => r.json() as Promise<Record<string, unknown>>)
  const second = await openWorkspace(me.id, workspaceId)
  const stopped = parsed.data.keep ? null : await stopWorkspace(me.id, workspaceId)
  const row = await getWorkspace(me.id, workspaceId)
  if (temporary && parsed.data.cleanup !== false) {
    await destroyWorkspaceSandbox(me.id, workspaceId)
    await deleteWorkspace(me.id, workspaceId)
  }
  return Response.json({
    workspaceId,
    temporary,
    first: { start: conn.start, ms: conn.ms, engineVersion: conn.engineVersion, baseUrl: conn.baseUrl, directory: conn.directory },
    health,
    second: { start: second.start, ms: second.ms },
    stopped,
    sandbox: row?.sandbox ? { status: row.sandbox.status, region: row.sandbox.region, totalCpuMs: row.sandbox.totalCpuMs } : null,
    totalMs: Date.now() - t0,
  })
})
