import { notFound } from "next/navigation"
import { WorkspaceView } from "@/components/workspace-view"
import { requireUser } from "@/server/cloud/session"
import { getWorkspace } from "@/server/cloud/workspaces"

export default async function WorkspaceSessionPage({ params }: PageProps<"/w/[id]/s/[sid]">) {
  const { id, sid } = await params
  const me = await requireUser()
  const ws = await getWorkspace(me.id, id)
  if (!ws) notFound()
  return <WorkspaceView workspaceId={ws.id} name={ws.name} sessionId={sid} />
}
