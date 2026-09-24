import { createOpencodeClient } from "@opencode-ai/sdk/client"
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
  /** If set, send this prompt to the agent through the syrup router and return its reply. */
  prompt: z.string().max(2000).optional(),
})

/** One round trip through OpenCode inside the sandbox, using the syrup/auto alias (i.e. the sidecar router). */
async function ask(baseUrl: string, authorization: string, directory: string, text: string) {
  const client = createOpencodeClient({ baseUrl, directory, headers: { authorization } })
  const t0 = Date.now()
  const mcp = await client.mcp.status()
  const created = await client.session.create({ body: { title: "probe" } })
  if (!created.data) throw new Error(`session.create failed: ${JSON.stringify(created.error).slice(0, 300)}`)
  const reply = await client.session.prompt({ path: { id: created.data.id }, body: { model: { providerID: "syrup", modelID: "auto" }, parts: [{ type: "text", text }] } })
  if (!reply.data) throw new Error(`prompt failed: ${JSON.stringify(reply.error).slice(0, 500)}`)
  const answer = reply.data.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
  return { mcp: mcp.data, sessionId: created.data.id, answer: answer.slice(0, 800), provider: reply.data.info.providerID, model: reply.data.info.modelID, tokens: reply.data.info.tokens, cost: reply.data.info.cost, ms: Date.now() - t0 }
}

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
  let chat: Awaited<ReturnType<typeof ask>> | { error: string } | null = null
  if (parsed.data.prompt) {
    try {
      chat = await ask(conn.baseUrl, conn.authorization, conn.directory, parsed.data.prompt)
    } catch (err) {
      chat = { error: err instanceof Error ? err.message : String(err) }
    }
  }
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
    chat,
    stopped,
    sandbox: row?.sandbox ? { status: row.sandbox.status, region: row.sandbox.region, totalCpuMs: row.sandbox.totalCpuMs } : null,
    totalMs: Date.now() - t0,
  })
})
