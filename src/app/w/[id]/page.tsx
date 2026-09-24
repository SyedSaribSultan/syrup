import { notFound } from "next/navigation"
import { WorkspaceView } from "@/components/workspace-view"
import { requireUser } from "@/server/cloud/session"
import { getWorkspace } from "@/server/cloud/workspaces"

export default async function WorkspacePage({ params }: PageProps<"/w/[id]">) {
  const { id } = await params
  const me = await requireUser()
  const ws = await getWorkspace(me.id, id)
  if (!ws) notFound()
  return <WorkspaceView workspaceId={ws.id} name={ws.name} egressAllow={ws.egressAllow} />
}
