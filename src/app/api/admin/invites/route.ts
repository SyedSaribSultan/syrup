import { desc, eq } from "drizzle-orm"
import { ulid } from "ulid"
import { z } from "zod"
import { audit } from "@/server/cloud/audit"
import { handler, requireAdmin } from "@/server/cloud/session"
import { pg, pgReady, pgSchema } from "@/server/db/pg"
import { env } from "@/server/env"

export const dynamic = "force-dynamic"

export const GET = handler(async () => {
  await requireAdmin()
  await pgReady()
  const rows = await pg().select().from(pgSchema.invites).orderBy(desc(pgSchema.invites.createdAt))
  return Response.json({ invites: rows, envInvites: env.invites, adminEmails: env.adminEmails })
})

const Body = z.object({ email: z.string().trim().toLowerCase().email(), note: z.string().trim().max(200).optional() })

export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin()
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "give a valid email" }, { status: 400 })
  await pgReady()
  const db = pg()
  const [existing] = await db.select().from(pgSchema.invites).where(eq(pgSchema.invites.email, parsed.data.email))
  let row
  if (existing) {
    ;[row] = await db.update(pgSchema.invites).set({ revokedAt: null, note: parsed.data.note ?? existing.note, invitedBy: admin.email }).where(eq(pgSchema.invites.id, existing.id)).returning()
  } else {
    ;[row] = await db.insert(pgSchema.invites).values({ id: ulid(), email: parsed.data.email, note: parsed.data.note ?? null, invitedBy: admin.email }).returning()
  }
  await audit(null, { userId: admin.id, actor: "admin", action: "invite.add", target: parsed.data.email })
  return Response.json({ invite: row })
})

export const DELETE = handler(async (req: Request) => {
  const admin = await requireAdmin()
  const id = new URL(req.url).searchParams.get("id")
  if (!id) return Response.json({ error: "id required" }, { status: 400 })
  await pgReady()
  const [row] = await pg().update(pgSchema.invites).set({ revokedAt: new Date() }).where(eq(pgSchema.invites.id, id)).returning()
  if (row) await audit(null, { userId: admin.id, actor: "admin", action: "invite.revoke", target: row.email })
  return Response.json({ ok: true })
})
