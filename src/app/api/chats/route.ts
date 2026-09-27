import { listAllSessions } from "@/server/cloud/history"
import { handler, requireUser } from "@/server/cloud/session"

export const dynamic = "force-dynamic"

export const GET = handler(async () => {
  const me = await requireUser()
  const rows = await listAllSessions(me.id)
  return Response.json({ chats: rows.map((r) => ({ id: r.id, title: r.title ?? "", workspaceId: r.workspaceId, updated: r.updatedAt.getTime() })) })
})
