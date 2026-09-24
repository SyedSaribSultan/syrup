import { ulid } from "ulid"
import { z } from "zod"
import { verifyIngestToken } from "@/server/cloud/ingest"
import { pg, pgReady, pgSchema } from "@/server/db/pg"

export const dynamic = "force-dynamic"

const Row = z.object({
  ts: z.number(),
  level: z.enum(["debug", "info", "warn", "error"]),
  source: z.string().max(20),
  event: z.string().max(120),
  data: z.unknown().optional(),
  sessionId: z.string().nullable().optional(),
})
const Body = z.object({ rows: z.array(Row).max(500) })

/** Log rows shipped by a sandbox sidecar. The token binds them to one user and workspace. */
export async function POST(req: Request) {
  const claims = verifyIngestToken(req.headers.get("authorization")?.replace(/^Bearer /, ""))
  if (!claims) return Response.json({ error: "invalid ingest token" }, { status: 401 })
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid rows" }, { status: 400 })
  await pgReady()
  const rows = parsed.data.rows.map((r) => ({ id: ulid(), ts: new Date(r.ts), level: r.level, source: r.source, event: r.event, userId: claims.u, workspaceId: claims.w, data: { ...(typeof r.data === "object" && r.data ? (r.data as object) : { value: r.data }), sessionId: r.sessionId ?? undefined } }))
  if (rows.length) await pg().insert(pgSchema.logs).values(rows)
  return Response.json({ ok: true, n: rows.length })
}
