import { z } from "zod"
import { handler, requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { deleteMemory, updateMemory } from "@/server/memory"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

const Patch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).optional(),
  kind: z.string().optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
})

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const me = env.isCloud ? await requireUser() : null
  const { id } = await ctx.params
  const parsed = Patch.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 })
  const m = me ? await (await import("@/server/cloud/memory")).cloudMemories(me.id).update(id, parsed.data) : await updateMemory(id, parsed.data)
  return m ? Response.json(m) : Response.json({ error: "Not found" }, { status: 404 })
})

export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const me = env.isCloud ? await requireUser() : null
  const { id } = await ctx.params
  if (me) {
    const { cloudMemories } = await import("@/server/cloud/memory")
    await cloudMemories(me.id).delete(id)
  } else {
    await deleteMemory(id)
  }
  return Response.json({ ok: true })
})
