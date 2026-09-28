import { z } from "zod"
import { handler } from "@/server/cloud/session"
import { currentOwner } from "@/server/share-owner"
import { createShare, listShares, requestOrigin } from "@/server/shares"

export const dynamic = "force-dynamic"

/** The owner's live share links, newest first. `?session=<id>` narrows to that chat's link and adds its counts. */
export const GET = handler(async (req: Request) => {
  const owner = await currentOwner()
  const u = new URL(req.url)
  const sessionId = u.searchParams.get("session") ?? undefined
  if (sessionId !== undefined && (!sessionId || sessionId.length > 200)) return Response.json({ error: "session must be a non-empty id" }, { status: 400 })
  const shares = await listShares(owner, requestOrigin(req), { sessionId })
  return Response.json({ shares }, { headers: { "cache-control": "no-store" } })
})

const Body = z.object({
  sessionId: z.string().min(1).max(200),
  /** Cloud: the chat's workspace (checked against the chat). */
  workspaceId: z.string().min(1).max(100).optional(),
  /** Local: the workspace folder the chat lives in (saves a search across projects). */
  directory: z.string().min(1).max(1024).optional(),
})

/** Creates a public link to a snapshot of the chat, or returns the live one it already has (`existing: true`). */
export const POST = handler(async (req: Request) => {
  const owner = await currentOwner()
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "sessionId is required" }, { status: 400 })
  const out = await createShare(owner, parsed.data, requestOrigin(req))
  return Response.json(out, { status: out.existing ? 200 : 201 })
})
