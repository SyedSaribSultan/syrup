import { handler, requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { listProviders } from "@/server/providers"

export const dynamic = "force-dynamic"

export const GET = handler(async () => {
  if (env.isCloud) {
    const me = await requireUser()
    const { listProviders: cloudList } = await import("@/server/cloud/keys")
    return Response.json(await cloudList(me.id))
  }
  return Response.json(await listProviders())
})
