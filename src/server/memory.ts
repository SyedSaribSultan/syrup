import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { desc, eq, sql } from "drizzle-orm"
import { db, dbReady, schema } from "./db"
import { env } from "./env"

/**
 * Long-term memory for the agent. Stored in SQLite, searched with FTS5, and
 * summarised into an index file that OpenCode loads as instructions on every
 * turn, so the agent always knows what it remembers.
 */

export type Memory = typeof schema.memories.$inferSelect
export type MemoryKind = "fact" | "preference" | "project" | "reference" | "note"
export const KINDS: MemoryKind[] = ["fact", "preference", "project", "reference", "note"]

function dataDir() {
  return env.dbUrl.startsWith("file:") ? path.dirname(path.resolve(env.dbUrl.slice(5))) : path.resolve("data")
}

/** Absolute path of the index file injected into the agent's instructions. */
export function memoryIndexPath() {
  return path.join(dataDir(), "memory", "MEMORY.md")
}

function normTags(tags: string | string[] | undefined): string {
  const list = Array.isArray(tags) ? tags : (tags ?? "").split(",")
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))].join(",")
}

export async function listMemories(limit = 200): Promise<Memory[]> {
  await dbReady()
  return db().select().from(schema.memories).orderBy(desc(schema.memories.updatedAt)).limit(limit)
}

export async function getMemory(id: string): Promise<Memory | undefined> {
  await dbReady()
  const [row] = await db().select().from(schema.memories).where(eq(schema.memories.id, id))
  return row
}

/** Full-text search. Falls back to a LIKE scan if the query cannot be parsed by FTS5. */
export async function searchMemories(query: string, limit = 10): Promise<(Memory & { score: number })[]> {
  await dbReady()
  const q = query.trim()
  if (!q) return (await listMemories(limit)).map((m) => ({ ...m, score: 0 }))
  const m = schema.memories
  // Quote each term so punctuation in user text does not break the FTS query.
  const terms = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ")
  try {
    const rows = await db()
      .select({ id: m.id, kind: m.kind, title: m.title, content: m.content, tags: m.tags, sessionId: m.sessionId, source: m.source, createdAt: m.createdAt, updatedAt: m.updatedAt, score: sql<number>`bm25(memories_fts)` })
      .from(sql`memories_fts`)
      .innerJoin(m, sql`${m.id} = memories_fts.id`)
      .where(sql`memories_fts MATCH ${terms}`)
      .orderBy(sql`bm25(memories_fts)`)
      .limit(limit)
    return rows
  } catch {
    const like = `%${q}%`
    const rows = await db()
      .select()
      .from(m)
      .where(sql`${m.title} LIKE ${like} OR ${m.content} LIKE ${like} OR ${m.tags} LIKE ${like}`)
      .orderBy(desc(m.updatedAt))
      .limit(limit)
    return rows.map((r) => ({ ...r, score: 0 }))
  }
}

export async function saveMemory(input: {
  title: string
  content: string
  kind?: string
  tags?: string | string[]
  sessionId?: string | null
  source?: "agent" | "user"
}): Promise<Memory> {
  await dbReady()
  const now = Date.now()
  const row: Memory = {
    id: `mem_${crypto.randomBytes(8).toString("hex")}`,
    kind: KINDS.includes(input.kind as MemoryKind) ? (input.kind as MemoryKind) : "note",
    title: input.title.trim().slice(0, 200),
    content: input.content.trim(),
    tags: normTags(input.tags),
    sessionId: input.sessionId ?? null,
    source: input.source ?? "agent",
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(schema.memories).values(row)
  await writeIndex()
  return row
}

export async function updateMemory(id: string, patch: Partial<Pick<Memory, "title" | "content" | "kind"> & { tags: string | string[] }>): Promise<Memory | undefined> {
  await dbReady()
  const set: Partial<Memory> = { updatedAt: Date.now() }
  if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200)
  if (patch.content !== undefined) set.content = patch.content.trim()
  if (patch.kind !== undefined && KINDS.includes(patch.kind as MemoryKind)) set.kind = patch.kind
  if (patch.tags !== undefined) set.tags = normTags(patch.tags)
  await db().update(schema.memories).set(set).where(eq(schema.memories.id, id))
  await writeIndex()
  return getMemory(id)
}

export async function deleteMemory(id: string): Promise<void> {
  await dbReady()
  await db().delete(schema.memories).where(eq(schema.memories.id, id))
  await writeIndex()
}

/** Regenerates MEMORY.md. Cheap; called after every change and at boot. */
export async function writeIndex(): Promise<string> {
  const file = memoryIndexPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let rows: Memory[] = []
  try {
    rows = await listMemories(150)
  } catch {
    // DB not ready yet: still write the header so the engine has a file to load.
  }
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
  fs.writeFileSync(file, lines.join("\n"), "utf8")
  return file
}
