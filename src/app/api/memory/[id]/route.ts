import { z } from "zod"
import { deleteMemory, updateMemory } from "@/server/memory"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

const Patch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).optional(),
  kind: z.string().optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
})

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  const parsed = Patch.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 })
  const m = await updateMemory(id, parsed.data)
  return m ? Response.json(m) : Response.json({ error: "Not found" }, { status: 404 })
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  await deleteMemory(id)
  return Response.json({ ok: true })
}
