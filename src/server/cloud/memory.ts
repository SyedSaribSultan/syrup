import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { ulid } from "ulid"
import { pgSchema, withUser } from "../db/pg"
import { KINDS, type MemoryKind, type MemoryRecord, type MemoryStore } from "../memory/tools"

/**
 * Cloud memory store: Postgres, per user, full-text search over the stored
 * tsvector (see drizzle-pg/*_rls_history.sql). Used by /api/ingest/memory
 * (the sidecar's MemoryStore talks to it) and by the memory UI later.
 */

type Row = typeof pgSchema.memories.$inferSelect

const toRecord = (r: Row): MemoryRecord => ({ id: r.id, kind: r.kind, title: r.title, content: r.content, tags: r.tags.join(",") })

function normTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))]
}

export function pgMemoryStore(userId: string): MemoryStore {
  const m = pgSchema.memories
  const live = and(eq(m.userId, userId), isNull(m.deletedAt))
  return {
    async list(limit) {
      const rows = await withUser(userId, (tx) => tx.select().from(m).where(live).orderBy(desc(m.updatedAt)).limit(limit))
      return rows.map(toRecord)
    },
    async get(id) {
      const [row] = await withUser(userId, (tx) => tx.select().from(m).where(and(live, eq(m.id, id))))
      return row ? toRecord(row) : undefined
    },
    async search(query, limit) {
      const q = query.trim()
      if (!q) return this.list(limit)
      const rows = await withUser(userId, async (tx) => {
        const hits = await tx
          .select()
          .from(m)
          .where(and(live, sql`${m}.search @@ websearch_to_tsquery('english', ${q})`))
          .orderBy(sql`ts_rank(${m}.search, websearch_to_tsquery('english', ${q})) desc`)
          .limit(limit)
        if (hits.length) return hits
        const like = `%${q}%`
        return tx.select().from(m).where(and(live, sql`(${m.title} ILIKE ${like} OR ${m.content} ILIKE ${like})`)).orderBy(desc(m.updatedAt)).limit(limit)
      })
      return rows.map(toRecord)
    },
    async save(input) {
      const [row] = await withUser(userId, (tx) =>
        tx
          .insert(m)
          .values({
            id: ulid(),
            userId,
            kind: KINDS.includes(input.kind as MemoryKind) ? (input.kind as MemoryKind) : "note",
            title: input.title.trim().slice(0, 200),
            content: input.content.trim(),
            tags: normTags(input.tags),
            source: "agent",
          })
          .returning(),
      )
      return toRecord(row)
    },
    async update(id, patch) {
      const set: Partial<typeof pgSchema.memories.$inferInsert> = { updatedAt: new Date() }
      if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200)
      if (patch.content !== undefined) set.content = patch.content.trim()
      if (patch.kind !== undefined && KINDS.includes(patch.kind as MemoryKind)) set.kind = patch.kind
      if (patch.tags !== undefined) set.tags = normTags(patch.tags)
      const [row] = await withUser(userId, (tx) => tx.update(m).set(set).where(and(live, eq(m.id, id))).returning())
      return row ? toRecord(row) : undefined
    },
    async delete(id) {
      await withUser(userId, (tx) => tx.update(m).set({ deletedAt: new Date() }).where(and(live, eq(m.id, id))))
    },
  }
}

/** The MEMORY.md the agent loads as instructions; same text as local mode's writeIndex(). */
export function renderMemoryIndex(rows: MemoryRecord[]): string {
  const lines = [
    "# Long-term memory",
    "",
    "You have persistent memory across sessions, provided by syrup.",
    "- Use the `memory_search` tool to recall details before asking the user something they may have told you before.",
    "- Use `memory_save` when you learn something worth keeping: user preferences, project facts, decisions, conventions, external references. Keep each memory to one fact with a clear title.",
    "- Use `memory_update` / `memory_forget` when a memory turns out to be wrong or stale.",
    "- Do not save things already recorded in the codebase or git history.",
    "",
    rows.length === 0 ? "_No memories saved yet._" : `## Index (${rows.length} most recent)`,
    "",
  ]
  for (const r of rows) {
    const preview = r.content.replace(/\s+/g, " ").slice(0, 140)
    const tags = r.tags ? ` [${r.tags.split(",").join(", ")}]` : ""
    lines.push(`- **${r.title}** (${r.kind}${tags}) — ${preview}${r.content.length > 140 ? "…" : ""}`)
  }
  lines.push("")
  return lines.join("\n")
}
