import { z } from "zod"
import { listMemories, saveMemory, searchMemories } from "@/server/memory"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const q = url.searchParams.get("q") ?? ""
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100)))
  const rows = q ? await searchMemories(q, limit) : await listMemories(limit)
  return Response.json({ memories: rows })
}

const Body = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1),
  kind: z.string().optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
})

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 })
  const m = await saveMemory({ ...parsed.data, source: "user" })
  return Response.json(m)
}
