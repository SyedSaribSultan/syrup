import { z } from "zod"
import { handler, requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { addKey } from "@/server/providers"

export const dynamic = "force-dynamic"

const Body = z.object({
  key: z.string().trim().min(8, "That key looks too short"),
  label: z.string().trim().max(60).default(""),
  tier: z.enum(["free", "paid"]).default("free"),
})

export const POST = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 })
  if (env.isCloud) {
    const me = await requireUser()
    const { addKey: cloudAdd } = await import("@/server/cloud/keys")
    return Response.json(await cloudAdd(me.id, id, parsed.data.key, parsed.data.label, parsed.data.tier))
  }
  return Response.json(await addKey(id, parsed.data.key, parsed.data.label, parsed.data.tier))
})
