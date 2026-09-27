import { redirect } from "next/navigation"
import { CloudHome } from "@/components/cloud-home"
import { LocalHome } from "@/components/local-home"
import { env } from "@/server/env"

export default async function Home() {
  if (!env.isCloud) return <LocalHome />
  const { requireUser } = await import("@/server/cloud/session")
  const me = await requireUser()
  // Same as local mode: home is a new chat in the workspace you used last.
  const { listWorkspaces } = await import("@/server/cloud/workspaces")
  const list = await listWorkspaces(me.id)
  const last = [...list].sort((a, b) => (b.lastOpenedAt ?? b.createdAt).getTime() - (a.lastOpenedAt ?? a.createdAt).getTime())[0]
  if (last) redirect(`/w/${last.id}`)
  const { listProviders } = await import("@/server/cloud/keys")
  const connected = (await listProviders(me.id)).providers.some((p) => p.connected)
  return <CloudHome name={me.name ?? null} hasKeys={connected} />
}
