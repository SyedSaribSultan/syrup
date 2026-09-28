import crypto from "node:crypto"
import { sql } from "drizzle-orm"
import type { TMessage } from "@/lib/transcript"
import { audit } from "@/server/cloud/audit"
import { deriveKey } from "@/server/cloud/crypto"
import { handler, requireAdmin } from "@/server/cloud/session"
import { pgAdmin, pgReady } from "@/server/db/pg"
import { researchTranscript } from "@/server/shares"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const RESEARCH_FORMAT = "syrup.research"

/**
 * The research dataset (PLAN §6 layer C) as JSON Lines, one chat per line.
 * Only users whose research consent is live and whose account is not deleted
 * are included, checked at export time so a revoked consent drops out of the
 * next export. Every chat goes through the share-link sanitizer (secrets, the
 * user's keys and email, paths); attachments are dropped; user and chat ids
 * are replaced by stable pseudonyms; each reply carries its thumbs rating.
 */
export const GET = handler(async () => {
  const admin = await requireAdmin()
  await pgReady()
  const db = pgAdmin()
  const users = (
    await db.execute<{ id: string; email: string }>(sql`
      select u.id, u.email from users u
      where u.deleted_at is null and exists (select 1 from consents c where c.user_id = u.id and c.kind = 'research' and c.revoked_at is null)`)
  ).rows
  await audit(null, { userId: admin.id, actor: "admin", action: "research.export", data: { users: users.length } })

  const key = deriveKey("research-export")
  const alias = (prefix: string, id: string) => `${prefix}_${crypto.createHmac("sha256", key).update(id).digest("base64url").slice(0, 16)}`
  const enc = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const u of users) {
          const chats = (await db.execute<{ id: string }>(sql`select id from chat_sessions where user_id = ${u.id} and deleted_at is null order by created_at`)).rows
          const ratings = new Map((await db.execute<{ message_id: string; rating: number }>(sql`select message_id, rating from message_feedback where user_id = ${u.id}`)).rows.map((r) => [r.message_id, r.rating > 0 ? 1 : -1]))
          for (const c of chats) {
            const t = await researchTranscript(u, c.id)
            if (!t || t.messages.length === 0) continue
            const messages = t.messages.map((m) => ({ ...strip(m), id: alias("msg", m.id), feedback: ratings.get(m.id) ?? null }))
            const record = { format: RESEARCH_FORMAT, version: 1, user: alias("user", u.id), chat: alias("chat", c.id), title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, models: t.models, stats: t.stats, messages }
            controller.enqueue(enc.encode(JSON.stringify(record) + "\n"))
          }
        }
      } catch (err) {
        controller.enqueue(enc.encode(JSON.stringify({ format: RESEARCH_FORMAT, error: err instanceof Error ? err.message : String(err) }) + "\n"))
      }
      controller.close()
    },
  })

  const day = new Date().toISOString().slice(0, 10)
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="syrup-research-${day}.jsonl"`,
      "cache-control": "no-store",
    },
  })
})

/** Attachments carry images and files, not dialogue: keep what they were, drop their data. */
function strip(m: TMessage): TMessage {
  return {
    ...m,
    parts: m.parts.map((p) => {
      if (p.type === "file") return { ...p, url: undefined, omitted: p.omitted ?? "size" }
      if (p.type === "tool" && p.attachments) return { ...p, attachments: p.attachments.map((a) => ({ ...a, url: undefined, omitted: a.omitted ?? "size" })) }
      return p
    }),
  }
}
