import { z } from "zod"
import { applyEvents, recordRouterEvents } from "@/server/cloud/history"
import { verifyIngestToken, type IngestClaims } from "@/server/cloud/ingest"
import { pgMemoryStore } from "@/server/cloud/memory"

export const dynamic = "force-dynamic"

/**
 * Everything a sandbox sidecar sends home, one route:
 *   POST /api/ingest/router          { events: RouterEvent[] }
 *   POST /api/ingest/events          { events: EngineEvent[] }   (OpenCode session/message/part events)
 *   POST /api/ingest/memory/<op>     search | list | get | save | update | delete
 * The token binds every write to one user and one workspace; RLS does the rest.
 * (/api/ingest/logs has its own route.)
 */

const RouterEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  alias: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  keyId: z.string().nullable(),
  tier: z.enum(["free", "paid"]),
  status: z.string(),
  httpStatus: z.number().nullable(),
  attempts: z.number(),
  latencyMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  error: z.string().nullable(),
})

const EngineEventSchema = z.object({ type: z.string(), properties: z.record(z.string(), z.unknown()).default({}) })

async function memory(op: string, claims: IngestClaims, body: Record<string, unknown>): Promise<Response> {
  const store = pgMemoryStore(claims.u)
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined)
  const n = (k: string, d: number) => (typeof body[k] === "number" ? Math.min(100, Math.max(1, body[k] as number)) : d)
  const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined
  switch (op) {
    case "search":
      return Response.json(await store.search(s("query") ?? "", n("limit", 8)))
    case "list":
      return Response.json(await store.list(n("limit", 20)))
    case "get":
      return Response.json((await store.get(s("id") ?? "")) ?? null)
    case "save": {
      const title = s("title")
      const content = s("content")
      if (!title || !content) return Response.json({ error: "title and content required" }, { status: 400 })
      return Response.json(await store.save({ title, content, kind: s("kind"), tags }))
    }
    case "update": {
      const id = s("id")
      if (!id) return Response.json({ error: "id required" }, { status: 400 })
      return Response.json((await store.update(id, { title: s("title"), content: s("content"), kind: s("kind"), tags })) ?? null)
    }
    case "delete":
      await store.delete(s("id") ?? "")
      return Response.json({ ok: true })
    default:
      return Response.json({ error: `unknown memory op ${op}` }, { status: 404 })
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ op: string[] }> }) {
  const claims = verifyIngestToken(req.headers.get("authorization")?.replace(/^Bearer /, ""))
  if (!claims) return Response.json({ error: "invalid ingest token" }, { status: 401 })
  const { op } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    if (op[0] === "router") {
      const parsed = z.object({ events: z.array(RouterEventSchema).max(200) }).safeParse(body)
      if (!parsed.success) return Response.json({ error: "invalid events" }, { status: 400 })
      await recordRouterEvents(claims.u, claims.w, parsed.data.events)
      return Response.json({ ok: true, n: parsed.data.events.length })
    }
    if (op[0] === "events") {
      const parsed = z.object({ events: z.array(EngineEventSchema).max(500) }).safeParse(body)
      if (!parsed.success) return Response.json({ error: "invalid events" }, { status: 400 })
      return Response.json({ ok: true, ...(await applyEvents(claims.u, claims.w, parsed.data.events)) })
    }
    if (op[0] === "memory" && op[1]) return await memory(op[1], claims, body)
    return Response.json({ error: `unknown ingest op ${op.join("/")}` }, { status: 404 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
