import { sql } from "drizzle-orm"
import { handler, requireAdmin } from "@/server/cloud/session"
import { pgAdmin, pgReady } from "@/server/db/pg"

export const dynamic = "force-dynamic"

/**
 * Cross-user aggregates for the admin Insights section: counts only, never
 * content. Owner connection on purpose (RLS would scope it to the admin).
 * Windows: growth compares this week with last week; quality and models look
 * at the last 30 days; the funnel and research counts are all-time.
 */
export const GET = handler(async () => {
  await requireAdmin()
  await pgReady()
  const db = pgAdmin()
  const one = async <T,>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows[0] as T
  const live = sql`(select id from users where deleted_at is null)`

  const [growth, funnel, quality, models, thumbs, research] = await Promise.all([
    one<{ users: number; new7: number; newPrev7: number; active7: number; activePrev7: number }>(sql`
      select
        (select count(*)::int from users where deleted_at is null) as "users",
        (select count(*)::int from users where deleted_at is null and created_at > now() - interval '7 days') as "new7",
        (select count(*)::int from users where deleted_at is null and created_at between now() - interval '14 days' and now() - interval '7 days') as "newPrev7",
        (select count(distinct user_id)::int from messages where role = 'user' and created_at > now() - interval '7 days' and user_id in ${live}) as "active7",
        (select count(distinct user_id)::int from messages where role = 'user' and created_at between now() - interval '14 days' and now() - interval '7 days' and user_id in ${live}) as "activePrev7"`),
    one<{ signedUp: number; addedKey: number; sentMessage: number; cameBack: number }>(sql`
      select
        (select count(*)::int from users where deleted_at is null) as "signedUp",
        (select count(distinct user_id)::int from provider_keys where user_id in ${live}) as "addedKey",
        (select count(distinct user_id)::int from messages where role = 'user' and user_id in ${live}) as "sentMessage",
        (select count(*)::int from (select user_id from messages where role = 'user' and user_id in ${live} group by user_id having count(distinct date_trunc('day', created_at)) >= 2) d) as "cameBack"`),
    one<{ turns: number; up: number; down: number; stopped: number; errors: number; denied: number }>(sql`
      select
        (select count(*)::int from messages where role = 'user' and created_at > now() - interval '30 days') as "turns",
        (select count(*)::int from message_feedback where rating > 0 and updated_at > now() - interval '30 days') as "up",
        (select count(*)::int from message_feedback where rating < 0 and updated_at > now() - interval '30 days') as "down",
        (select count(*)::int from messages where role = 'assistant' and created_at > now() - interval '30 days' and info->'error'->>'name' = 'MessageAbortedError') as "stopped",
        (select count(*)::int from messages where role = 'assistant' and created_at > now() - interval '30 days' and info->'error' is not null and info->'error'->>'name' <> 'MessageAbortedError') as "errors",
        (select count(*)::int from messages m, jsonb_each(m.parts) p
          where m.created_at > now() - interval '30 days' and p.value->>'type' = 'tool'
            and p.value->'state'->>'status' = 'error' and p.value->'state'->>'error' like 'The user rejected permission%') as "denied"`),
    db.execute<{ provider: string; model: string; requests: number; viaAuto: number; failed: number; busy: number; ttftMs: number | null }>(sql`
      select provider_id as "provider", model_id as "model",
        count(*)::int as "requests",
        count(*) filter (where alias = 'auto')::int as "viaAuto",
        count(*) filter (where status in ('error', 'timeout'))::int as "failed",
        count(*) filter (where status = 'rate_limited')::int as "busy",
        (percentile_cont(0.5) within group (order by ttft_ms) filter (where status = 'ok' and ttft_ms is not null))::int as "ttftMs"
      from router_events where ts > now() - interval '30 days'
      group by 1, 2 order by 3 desc limit 25`),
    db.execute<{ provider: string | null; model: string | null; up: number; down: number }>(sql`
      select provider_id as "provider", model_id as "model",
        count(*) filter (where rating > 0)::int as "up", count(*) filter (where rating < 0)::int as "down"
      from message_feedback where updated_at > now() - interval '30 days'
      group by 1, 2`),
    one<{ consenting: number; chats: number; messages: number; rated: number }>(sql`
      with c as (select distinct user_id from consents where kind = 'research' and revoked_at is null and user_id in ${live})
      select
        (select count(*)::int from c) as "consenting",
        (select count(*)::int from chat_sessions where user_id in (select user_id from c) and deleted_at is null) as "chats",
        (select count(*)::int from messages where user_id in (select user_id from c)) as "messages",
        (select count(*)::int from message_feedback where user_id in (select user_id from c)) as "rated"`),
  ])

  // One row per model: the router's numbers plus the thumbs people gave it (direct picks included).
  const key = (p: string | null, m: string | null) => `${p ?? ""}/${m ?? ""}`
  const rows = new Map<string, { provider: string; model: string; requests: number; viaAuto: number; failed: number; busy: number; ttftMs: number | null; up: number; down: number }>()
  for (const r of models.rows) rows.set(key(r.provider, r.model), { ...r, up: 0, down: 0 })
  for (const t of thumbs.rows) {
    if (!t.model) continue
    const k = key(t.provider, t.model)
    const row = rows.get(k) ?? { provider: t.provider ?? "", model: t.model, requests: 0, viaAuto: 0, failed: 0, busy: 0, ttftMs: null, up: 0, down: 0 }
    row.up += t.up
    row.down += t.down
    rows.set(k, row)
  }

  return Response.json(
    {
      generatedAt: Date.now(),
      growth,
      funnel: [
        { step: "Signed up", users: funnel.signedUp },
        { step: "Added an API key", users: funnel.addedKey },
        { step: "Sent a message", users: funnel.sentMessage },
        { step: "Came back another day", users: funnel.cameBack },
      ],
      quality,
      models: [...rows.values()].sort((a, b) => b.requests + b.up + b.down - (a.requests + a.up + a.down)),
      research: { ...research, users: growth.users },
    },
    { headers: { "cache-control": "no-store" } },
  )
})
