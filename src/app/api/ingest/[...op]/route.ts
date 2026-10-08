import { z } from "zod"
import { applyEvents, recentRouterEvents, recordRouterEvents } from "@/server/cloud/history"
import { verifyIngestToken, type IngestClaims } from "@/server/cloud/ingest"
import { activeKeyMeta } from "@/server/cloud/keys"
import { pgMemoryStore } from "@/server/cloud/memory"
import { BASE_URL } from "@/server/router/backends"

export const dynamic = "force-dynamic"

/**
 * Everything a sandbox sidecar sends home or reads back, one route:
 *   POST /api/ingest/router          { events: RouterEvent[] }
 *   POST /api/ingest/events          { events: EngineEvent[] }   (OpenCode session/message/part events)
 *   POST /api/ingest/memory/<op>     search | list | get | save | update | delete
 *   GET  /api/ingest/router/keys     { keys: { [provider]: { id, tier } } }: key metadata, never a secret
 *   GET  /api/ingest/memory/version  { version } that changes whenever the user's memories do
 *   GET  /api/ingest/router/recent?since=<epoch ms>  the user's router attempts since then (a new sandbox's router seeds its health memory)
 * The token binds every call to one user and one workspace; RLS does the rest.
 * (/api/ingest/logs and the LLM relay, /api/ingest/llm/<provider>/..., have their own routes.)
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
  // Optional so a sidecar from before these fields keeps working until the sandbox restarts.
  sessionId: z.string().max(200).nullable().optional(),
  ttftMs: z.number().nullable().optional(),
  retryAt: z.number().nullable().optional(),
  reason: z.string().max(40).nullable().optional(),
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

/**
 * Reads. router/keys is polled by the sidecar so adding, switching or removing
 * a key reaches a running sandbox's router without a restart. It carries ids
 * and tiers only: the relay adds the secret per call, on the app side.
 */
export async function GET(req: Request, ctx: { params: Promise<{ op: string[] }> }) {
  const claims = verifyIngestToken(req.headers.get("authorization")?.replace(/^Bearer /, ""))
  if (!claims) return Response.json({ error: "invalid ingest token" }, { status: 401 })
  const { op } = await ctx.params
  if (op.join("/") === "memory/version") {
    try {
      return Response.json({ version: await pgMemoryStore(claims.u).version() }, { headers: { "cache-control": "no-store" } })
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }
  if (op.join("/") === "router/recent") {
    try {
      const since = Number(new URL(req.url).searchParams.get("since"))
      // At most an hour back: enough to know what is cooling or slow, small enough to answer fast.
      const floor = Date.now() - 3_600_000
      return Response.json({ events: await recentRouterEvents(claims.u, Number.isFinite(since) ? Math.max(since, floor) : floor) }, { headers: { "cache-control": "no-store" } })
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }
  if (op.join("/") !== "router/keys") return Response.json({ error: `unknown ingest op ${op.join("/")}` }, { status: 404 })
  try {
    const keys = Object.fromEntries(Object.entries(await activeKeyMeta(claims.u)).filter(([providerId]) => Object.hasOwn(BASE_URL, providerId)))
    return Response.json({ keys }, { headers: { "cache-control": "no-store" } })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
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
      await recordRouterEvents(
        claims.u,
        claims.w,
        parsed.data.events.map((e) => ({ ...e, sessionId: e.sessionId ?? null, ttftMs: e.ttftMs ?? null, retryAt: e.retryAt ?? null, reason: e.reason ?? null })),
      )
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
