import type { RouterStatus } from "@/lib/router-status"
import { handler, requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { cloudRouterStatus, localRouterStatus } from "@/server/router-status"

export const dynamic = "force-dynamic"

/** Router health, cooldowns and alias picks from the last 24 h of router_events. Cloud: the signed-in user's rows only. */
export const GET = handler(async () => {
  let status: RouterStatus
  if (env.isCloud) {
    const me = await requireUser()
    status = await cloudRouterStatus(me.id)
  } else {
    // Local mode listens on loopback only (proxy.ts), same as /api/usage.
    status = await localRouterStatus()
  }
  return Response.json(status, { headers: { "cache-control": "no-store" } })
})
