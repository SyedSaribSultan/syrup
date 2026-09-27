import { redirect } from "next/navigation"
import { LocalHome } from "@/components/local-home"
import { env } from "@/server/env"

export default async function Home() {
  if (!env.isCloud) return <LocalHome />
  const { requireUser } = await import("@/server/cloud/session")
  const me = await requireUser()
  // Every account has a Home workspace (created on first visit); a new chat starts there.
  const { ensureHome } = await import("@/server/cloud/workspaces")
  const home = await ensureHome(me.id)
  redirect(`/w/${home.id}`)
}
