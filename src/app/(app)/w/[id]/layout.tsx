import { notFound } from "next/navigation"
import { WorkspaceView } from "@/components/workspace-view"
import { listProviders } from "@/server/cloud/keys"
import { requireUser } from "@/server/cloud/session"
import { getWorkspace } from "@/server/cloud/workspaces"

/** One WorkspaceView (and one sandbox connection) for the new-chat screen and every chat in the workspace. */
export default async function WorkspaceLayout({ params }: LayoutProps<"/w/[id]">) {
  const { id } = await params
  const me = await requireUser()
  const [ws, keys] = await Promise.all([getWorkspace(me.id, id), listProviders(me.id)])
  if (!ws) notFound()
  return <WorkspaceView key={ws.id} workspaceId={ws.id} egressAllow={ws.egressAllow} hasKeys={keys.providers.some((p) => p.connected)} />
}
