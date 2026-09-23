import { CloudHome } from "@/components/cloud-home"
import { LocalHome } from "@/components/local-home"
import { env } from "@/server/env"

export default async function Home() {
  if (!env.isCloud) return <LocalHome />
  const { auth } = await import("@/auth")
  const session = await auth()
  const { listProviders } = await import("@/server/cloud/keys")
  const providers = session?.user ? (await listProviders(session.user.id)).providers.filter((p) => p.connected) : []
  return <CloudHome name={session?.user?.name ?? null} connected={providers.map((p) => p.name)} />
}
