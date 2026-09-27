import { env } from "@/server/env"
import { reveal, resolveInWorkspace, RevealError, type RevealAction } from "@/server/reveal"

export const dynamic = "force-dynamic"

const ACTIONS = new Set<RevealAction>(["reveal", "open", "folder"])

/** Shows a workspace file in the host's file manager, or opens it. Body: { workspace, path, action }. */
export async function POST(req: Request) {
  if (env.isCloud) return Response.json({ error: "not available in the hosted version" }, { status: 404 })
  const body = await req.json().catch(() => null)
  const { workspace, path, action } = (body ?? {}) as Record<string, unknown>
  if (typeof workspace !== "string" || typeof path !== "string" || !path || typeof action !== "string" || !ACTIONS.has(action as RevealAction)) {
    return Response.json({ error: "expected { workspace, path, action: reveal | open | folder }" }, { status: 400 })
  }
  try {
    const abs = resolveInWorkspace(workspace, path)
    await reveal(action as RevealAction, abs)
    return Response.json({ ok: true, path: abs })
  } catch (err) {
    if (err instanceof RevealError) return Response.json({ error: err.message }, { status: err.status })
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
