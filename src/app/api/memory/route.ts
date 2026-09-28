import { z } from "zod"
import { handler, requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { listMemories, saveMemory, searchMemories } from "@/server/memory"

export const dynamic = "force-dynamic"

export const GET = handler(async (req: Request) => {
  const url = new URL(req.url)
  const q = url.searchParams.get("q") ?? ""
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100))
  if (env.isCloud) {
    const me = await requireUser()
    const { cloudMemories } = await import("@/server/cloud/memory")
    return Response.json({ memories: await cloudMemories(me.id).list(q, limit) })
  }
  const rows = q ? await searchMemories(q, limit) : await listMemories(limit)
  return Response.json({ memories: rows })
})

const Body = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1),
  kind: z.string().optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
})

export const POST = handler(async (req: Request) => {
  const me = env.isCloud ? await requireUser() : null
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 })
  if (me) {
    const { cloudMemories } = await import("@/server/cloud/memory")
    return Response.json(await cloudMemories(me.id).save(parsed.data))
  }
  const m = await saveMemory({ ...parsed.data, source: "user" })
  return Response.json(m)
})
