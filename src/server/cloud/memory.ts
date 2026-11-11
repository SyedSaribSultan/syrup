import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm"
import { ulid } from "ulid"
import { pgSchema, withUser } from "../db/pg"
import { KINDS, type MemoryKind, type MemoryRecord, type MemoryStore } from "../memory/tools"

/**
 * Cloud memory store: Postgres, per user, full-text search over the stored
 * tsvector (see drizzle-pg/*_rls_history.sql). Memories are shared across all
 * of a user's workspaces. Used by /api/ingest/memory (the sidecar's
 * MemoryStore) and by /api/memory (the Memory page).
 *
 * States: live, forgotten (deleted_at set; restorable from the Memory page for
 * FORGOTTEN_DAYS), purged (the nightly cron deletes the row after that).
 */

/** How long a forgotten memory can be restored before the cron purges it. */
export const FORGOTTEN_DAYS = 30

type Row = typeof pgSchema.memories.$inferSelect

/** What /api/memory returns; the same shape as a local SQLite row. */
export type MemoryView = {
  id: string
  kind: string
  title: string
  content: string
  tags: string
  source: string
  sessionId: string | null
  createdAt: number
  updatedAt: number
}

const toRecord = (r: Row): MemoryRecord => ({ id: r.id, kind: r.kind, title: r.title, content: r.content, tags: r.tags.join(",") })

const toView = (r: Row): MemoryView => ({ ...toRecord(r), source: r.source, sessionId: null, createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime() })

function normTags(tags: string | string[] | undefined): string[] {
  const list = Array.isArray(tags) ? tags : (tags ?? "").split(",")
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))]
}

type SaveInput = { title: string; content: string; kind?: string; tags?: string | string[] }
type Patch = { title?: string; content?: string; kind?: string; tags?: string | string[] }

function memoryRows(userId: string) {
  const m = pgSchema.memories
  const live = and(eq(m.userId, userId), isNull(m.deletedAt))
  const list = (limit: number) => withUser(userId, (tx) => tx.select().from(m).where(live).orderBy(desc(m.updatedAt)).limit(limit))
  return {
    list,
    async get(id: string) {
      const [row] = await withUser(userId, (tx) => tx.select().from(m).where(and(live, eq(m.id, id))))
      return row
    },
    search(query: string, limit: number) {
      const q = query.trim()
      if (!q) return list(limit)
      return withUser(userId, async (tx) => {
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
    },
    async save(input: SaveInput, source: "agent" | "user") {
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
            source,
          })
          .returning(),
      )
      return row
    },
    async update(id: string, patch: Patch) {
      const set: Partial<typeof pgSchema.memories.$inferInsert> = { updatedAt: new Date() }
      if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200)
      if (patch.content !== undefined) set.content = patch.content.trim()
      if (patch.kind !== undefined && KINDS.includes(patch.kind as MemoryKind)) set.kind = patch.kind
      if (patch.tags !== undefined) set.tags = normTags(patch.tags)
      const [row] = await withUser(userId, (tx) => tx.update(m).set(set).where(and(live, eq(m.id, id))).returning())
      return row
    },
    async delete(id: string) {
      const now = new Date()
      await withUser(userId, (tx) => tx.update(m).set({ deletedAt: now, updatedAt: now }).where(and(live, eq(m.id, id))))
    },
    /** Forgotten in the last FORGOTTEN_DAYS, most recent first: what the Memory page can still restore. */
    forgotten(limit: number) {
      const since = new Date(Date.now() - FORGOTTEN_DAYS * 86_400_000)
      return withUser(userId, (tx) => tx.select().from(m).where(and(eq(m.userId, userId), isNotNull(m.deletedAt), gt(m.deletedAt, since))).orderBy(desc(m.deletedAt)).limit(limit))
    },
    async restore(id: string) {
      const [row] = await withUser(userId, (tx) => tx.update(m).set({ deletedAt: null, updatedAt: new Date() }).where(and(eq(m.userId, userId), eq(m.id, id), isNotNull(m.deletedAt))).returning())
      return row
    },
    /**
     * Changes whenever any of the user's memories is added, edited or forgotten (forgetting bumps updated_at too). The
     * count of all rows as well as live ones: an add and a forget landing at the same instant still move the stamp.
     */
    async version() {
      const [row] = await withUser(userId, (tx) =>
        tx
          .select({ at: sql<string | null>`max(${m.updatedAt})::text`, n: sql<number>`(count(*) filter (where ${m.deletedAt} is null))::int`, all: sql<number>`count(*)::int` })
          .from(m)
          .where(eq(m.userId, userId)),
      )
      return `${row?.at ?? "0"}|${row?.n ?? 0}|${row?.all ?? 0}`
    },
  }
}

/** The agent's view, through the sidecar. */
export function pgMemoryStore(userId: string): MemoryStore & { version(): Promise<string> } {
  const rows = memoryRows(userId)
  return {
    list: async (limit) => (await rows.list(limit)).map(toRecord),
    get: async (id) => {
      const r = await rows.get(id)
      return r ? toRecord(r) : undefined
    },
    search: async (query, limit) => (await rows.search(query, limit)).map(toRecord),
    save: async (input) => toRecord(await rows.save(input, "agent")),
    update: async (id, patch) => {
      const r = await rows.update(id, patch)
      return r ? toRecord(r) : undefined
    },
    delete: (id) => rows.delete(id),
    version: () => rows.version(),
  }
}

/** The Memory page's view, through /api/memory. */
export function cloudMemories(userId: string) {
  const rows = memoryRows(userId)
  return {
    list: async (query: string, limit: number) => (await rows.search(query, limit)).map(toView),
    save: async (input: SaveInput) => toView(await rows.save(input, "user")),
    update: async (id: string, patch: Patch) => {
      const r = await rows.update(id, patch)
      return r ? toView(r) : undefined
    },
    delete: (id: string) => rows.delete(id),
    forgotten: async (limit: number) => (await rows.forgotten(limit)).map(toView),
    restore: async (id: string) => {
      const r = await rows.restore(id)
      return r ? toView(r) : undefined
    },
  }
}

/** Undoes a forget (the Memory page's Restore). */
export async function restoreMemory(userId: string, id: string): Promise<MemoryView | undefined> {
  return cloudMemories(userId).restore(id)
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
