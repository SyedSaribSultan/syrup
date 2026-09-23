import { desc, sql } from "drizzle-orm"
import { db, dbReady, schema } from "@/server/db"

export const dynamic = "force-dynamic"

const u = schema.usageEvents

/** Aggregates for the cost dashboard. Everything comes from usage_events. */
export async function GET(req: Request) {
  await dbReady()
  const days = Math.max(1, Math.min(365, Number(new URL(req.url).searchParams.get("days") ?? 30)))
  const since = Date.now() - days * 86_400_000
  const d = db()

  const sums = {
    messages: sql<number>`count(*)`,
    input: sql<number>`coalesce(sum(${u.inputTokens}),0)`,
    output: sql<number>`coalesce(sum(${u.outputTokens}),0)`,
    reasoning: sql<number>`coalesce(sum(${u.reasoningTokens}),0)`,
    cacheRead: sql<number>`coalesce(sum(${u.cacheReadTokens}),0)`,
    cacheWrite: sql<number>`coalesce(sum(${u.cacheWriteTokens}),0)`,
    cost: sql<number>`coalesce(sum(${u.cost}),0)`,
    freeTokens: sql<number>`coalesce(sum(case when ${u.free}=1 then ${u.inputTokens}+${u.outputTokens}+${u.reasoningTokens} else 0 end),0)`,
    paidTokens: sql<number>`coalesce(sum(case when ${u.free}=0 then ${u.inputTokens}+${u.outputTokens}+${u.reasoningTokens} else 0 end),0)`,
  }
  const where = sql`${u.createdAt} >= ${since}`

  const [totals] = await d.select(sums).from(u).where(where)

  const byModel = await d
    .select({ providerId: u.providerId, modelId: u.modelId, free: u.free, ...sums })
    .from(u)
    .where(where)
    .groupBy(u.providerId, u.modelId, u.free)
    .orderBy(desc(sums.cost), desc(sums.input))

  const day = sql<string>`date(${u.createdAt}/1000,'unixepoch')`
  const byDay = await d
    .select({ day, ...sums })
    .from(u)
    .where(where)
    .groupBy(day)
    .orderBy(day)

  const bySession = await d
    .select({ sessionId: u.sessionId, last: sql<number>`max(${u.createdAt})`, ...sums })
    .from(u)
    .where(where)
    .groupBy(u.sessionId)
    .orderBy(desc(sql`max(${u.createdAt})`))
    .limit(50)

  return Response.json({ days, since, totals, byModel, byDay, bySession })
}
