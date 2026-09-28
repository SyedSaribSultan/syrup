import { after } from "next/server"
import { requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { removeSkill } from "@/server/skills"

export const dynamic = "force-dynamic"
/** Cloud: room for the after-response push to running sandboxes, which waits for busy sessions. */
export const maxDuration = 120

export async function DELETE(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params
  try {
    if (env.isCloud) {
      const me = await requireUser()
      const [skills, sandbox] = await Promise.all([import("@/server/cloud/skills"), import("@/server/engine/sandbox")])
      await skills.removeCloudSkill(me.id, name)
      after(() => sandbox.syncSkills(me.id))
      return Response.json({ ok: true })
    }
    await removeSkill(name)
    return Response.json({ ok: true })
  } catch (err) {
    if (err instanceof Response) return err
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
