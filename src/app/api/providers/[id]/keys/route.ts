import { z } from "zod"
import { addKey } from "@/server/providers"

export const dynamic = "force-dynamic"

const Body = z.object({
  key: z.string().trim().min(8, "That key looks too short"),
  label: z.string().trim().max(60).default(""),
  tier: z.enum(["free", "paid"]).default("free"),
})

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 })
  try {
    const key = await addKey(id, parsed.data.key, parsed.data.label, parsed.data.tier)
    return Response.json(key)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
