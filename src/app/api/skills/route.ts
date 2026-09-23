import { z } from "zod"
import { createSkill, installFromGit, listSkills, skillsDir } from "@/server/skills"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ skills: await listSkills(), dir: skillsDir() })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

const Body = z.union([
  z.object({ source: z.string().trim().min(3) }),
  z.object({ content: z.string().min(10), name: z.string().trim().optional() }),
])

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "Give a git source or SKILL.md content" }, { status: 400 })
  try {
    const installed = "source" in parsed.data ? await installFromGit(parsed.data.source) : [await createSkill(parsed.data.content, parsed.data.name)]
    return Response.json({ installed })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
