import { z } from "zod"
import { handler, requireUser } from "@/server/cloud/session"
import { track } from "@/server/analytics"
import { env } from "@/server/env"
import { addKey, defaultTier } from "@/server/providers"

export const dynamic = "force-dynamic"

const Body = z.object({
  key: z.string().trim().min(8, "That key looks too short"),
  label: z.string().trim().max(60).default(""),
  tier: z.enum(["free", "paid"]).optional(),
})

export const POST = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 })
  const tier = parsed.data.tier ?? defaultTier(id)
  if (env.isCloud) {
    const me = await requireUser()
    const { addKey: cloudAdd } = await import("@/server/cloud/keys")
    const out = await cloudAdd(me.id, id, parsed.data.key, parsed.data.label, tier)
    // The provider's catalog id and the tier only: never the key or its label.
    await track(me.id, "provider_key_added", { provider: /^[a-z0-9._-]{1,60}$/i.test(id) ? id : "other", tier, labelled: parsed.data.label.length > 0 })
    return Response.json(out)
  }
  return Response.json(await addKey(id, parsed.data.key, parsed.data.label, tier))
})
