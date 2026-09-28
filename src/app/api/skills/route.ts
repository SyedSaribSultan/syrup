import { after } from "next/server"
import { z } from "zod"
import { requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { createSkill, installFromGit, listSkills, setSkillsEnabled, skillsDir } from "@/server/skills"

export const dynamic = "force-dynamic"
/** Cloud: room for the after-response push to running sandboxes, which waits for busy sessions. */
export const maxDuration = 120

function fail(err: unknown, status: number) {
  if (err instanceof Response) return err
  return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status })
}

async function cloud() {
  const me = await requireUser()
  const [skills, sandbox] = await Promise.all([import("@/server/cloud/skills"), import("@/server/engine/sandbox")])
  return { me, skills, push: () => after(() => sandbox.syncSkills(me.id)) }
}

export async function GET() {
  try {
    if (env.isCloud) {
      const { me, skills } = await cloud()
      return Response.json({ skills: await skills.listCloudSkills(me.id), dir: skills.SANDBOX_SKILLS_DIR })
    }
    return Response.json({ skills: await listSkills(), dir: skillsDir() })
  } catch (err) {
    return fail(err, 500)
  }
}

const Body = z.union([
  z.object({ source: z.string().trim().min(3).max(500) }),
  z.object({ content: z.string().min(10).max(1_000_000), name: z.string().trim().max(64).optional() }),
])

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "Give a git source or SKILL.md content" }, { status: 400 })
  try {
    if (env.isCloud) {
      const { me, skills, push } = await cloud()
      const result = "source" in parsed.data ? await skills.installCloudFromGit(me.id, parsed.data.source) : { installed: [await skills.createCloudSkill(me.id, parsed.data.content, parsed.data.name)], skipped: [] }
      push()
      return Response.json(result)
    }
    const installed = "source" in parsed.data ? await installFromGit(parsed.data.source) : [await createSkill(parsed.data.content, parsed.data.name)]
    return Response.json({ installed })
  } catch (err) {
    return fail(err, 400)
  }
}

const Toggle = z.object({ enabled: z.record(z.string().min(1).max(128), z.boolean()) })

export async function PATCH(req: Request) {
  const parsed = Toggle.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "Give { enabled: { name: boolean } }" }, { status: 400 })
  try {
    if (env.isCloud) {
      const { me, skills, push } = await cloud()
      await skills.setCloudSkillsEnabled(me.id, parsed.data.enabled)
      push()
      return Response.json({ ok: true })
    }
    await setSkillsEnabled(parsed.data.enabled)
    return Response.json({ ok: true })
  } catch (err) {
    return fail(err, 500)
  }
}
