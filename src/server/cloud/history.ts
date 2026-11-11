import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm"
import { pgSchema, withUser, type PgTx } from "../db/pg"
import type { RouterEvent } from "../router/store"
import { invalidateShare } from "../share-cache"

/**
 * Chat history in cloud mode. The sandbox sidecar taps OpenCode's event bus
 * and forwards session/message/part events; this module folds them into
 * chat_sessions and messages. Postgres is the record; the sandbox is disposable.
 */

type SessionInfo = { id: string; title?: string; parentID?: string; time?: { created?: number; updated?: number } }
type MessageInfo = {
  id: string
  sessionID: string
  role: string
  providerID?: string
  modelID?: string
  agent?: string
  mode?: string
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  time?: { created?: number; completed?: number }
  error?: unknown
}
type PartInfo = { id: string; messageID: string; sessionID: string; type: string } & Record<string, unknown>

export type EngineEvent = { type: string; properties: Record<string, unknown> }

const ms = (n?: number) => (n ? new Date(n) : undefined)

/** A chat the user deleted: a late batch must not add messages to it. */
async function chatDeleted(tx: PgTx, sessionId: string): Promise<boolean> {
  const [cs] = await tx.select({ deletedAt: pgSchema.chatSessions.deletedAt }).from(pgSchema.chatSessions).where(eq(pgSchema.chatSessions.id, sessionId))
  return !!cs?.deletedAt
}

/** A part update replaces the stored part, except that a finished tool part (completed or error) is never set back to running by an older update. */
const TERMINAL = sql.raw(`('completed', 'error')`)

export async function applyEvents(userId: string, workspaceId: string, events: EngineEvent[]): Promise<{ applied: number }> {
  let applied = 0
  // Share links of chats deleted in this batch; their cached pages are expired after the commit.
  const revokedShares: string[] = []
  await withUser(userId, async (tx) => {
    for (const ev of events) {
      const p = ev.properties ?? {}
      switch (ev.type) {
        case "session.created":
        case "session.updated": {
          const info = p.info as SessionInfo | undefined
          if (!info?.id) break
          await tx
            .insert(pgSchema.chatSessions)
            .values({ id: info.id, userId, workspaceId, parentId: info.parentID ?? null, title: info.title ?? null, createdAt: ms(info.time?.created) ?? new Date(), updatedAt: ms(info.time?.updated ?? info.time?.created) ?? new Date() })
            // parentId too: a subagent's row may already exist from an earlier message event, created without it.
            .onConflictDoUpdate({ target: pgSchema.chatSessions.id, set: { title: info.title ?? null, parentId: info.parentID ?? null, updatedAt: ms(info.time?.updated) ?? new Date() } })
          applied++
          break
        }
        case "session.deleted": {
          const info = p.info as SessionInfo | undefined
          if (!info?.id) break
          await tx.update(pgSchema.chatSessions).set({ deletedAt: new Date() }).where(and(eq(pgSchema.chatSessions.id, info.id), eq(pgSchema.chatSessions.userId, userId)))
          // Deleting a chat takes its share link down too.
          const sc = pgSchema.sharedChats
          const gone = await tx.update(sc).set({ revokedAt: new Date() }).where(and(eq(sc.sessionId, info.id), eq(sc.userId, userId), isNull(sc.revokedAt))).returning({ id: sc.id })
          revokedShares.push(...gone.map((g) => g.id))
          applied++
          break
        }
        case "message.updated": {
          const info = p.info as MessageInfo | undefined
          if (!info?.id || !info.sessionID) break
          // A message can arrive before its session event; make sure the session row exists.
          await tx.insert(pgSchema.chatSessions).values({ id: info.sessionID, userId, workspaceId }).onConflictDoNothing()
          if (await chatDeleted(tx, info.sessionID)) break
          const t = info.tokens ?? {}
          const row = {
            id: info.id,
            userId,
            workspaceId,
            sessionId: info.sessionID,
            role: info.role,
            providerId: info.providerID ?? null,
            modelId: info.modelID ?? null,
            agent: info.agent ?? info.mode ?? null,
            info: info as unknown as Record<string, unknown>,
            inputTokens: t.input ?? 0,
            outputTokens: t.output ?? 0,
            reasoningTokens: t.reasoning ?? 0,
            cacheReadTokens: t.cache?.read ?? 0,
            cacheWriteTokens: t.cache?.write ?? 0,
            cost: info.cost ?? 0,
            // Alias models are billed by the router (router_events); the engine sees $0.
            free: (info.cost ?? 0) === 0,
            createdAt: ms(info.time?.created) ?? new Date(),
            completedAt: ms(info.time?.completed) ?? null,
          }
          const { id: _id, parts: _p, ...set } = { ...row, parts: undefined }
          void _id
          void _p
          // A finished reply stays finished: a replayed in-progress update (a resync after the engine restarted) keeps the
          // stored completion and info, including an interruption recorded when the engine session ended.
          const m = pgSchema.messages
          const kept = sql`${m.completedAt} is not null and excluded.completed_at is null`
          await tx
            .insert(m)
            .values(row)
            .onConflictDoUpdate({ target: m.id, set: { ...set, completedAt: sql`coalesce(excluded.completed_at, ${m.completedAt})`, info: sql`case when ${kept} then ${m.info} else excluded.info end` } })
          await tx.update(pgSchema.chatSessions).set({ updatedAt: new Date() }).where(eq(pgSchema.chatSessions.id, info.sessionID))
          applied++
          break
        }
        case "message.part.updated": {
          const part = p.part as PartInfo | undefined
          if (!part?.id || !part.messageID) break
          // Merge this part into the message's parts object (jsonb concatenation keeps the others).
          await tx.insert(pgSchema.chatSessions).values({ id: part.sessionID, userId, workspaceId }).onConflictDoNothing()
          if (await chatDeleted(tx, part.sessionID)) break
          const m = pgSchema.messages
          const stored = sql`${m.parts} -> ${part.id}`
          const incoming = (part.state as { status?: unknown } | undefined)?.status
          const older = typeof incoming === "string" && !["completed", "error"].includes(incoming) ? sql`(${stored} -> 'state' ->> 'status') in ${TERMINAL}` : sql`false`
          await tx
            .insert(m)
            .values({ id: part.messageID, userId, workspaceId, sessionId: part.sessionID, role: "unknown", parts: { [part.id]: part } })
            .onConflictDoUpdate({ target: m.id, set: { parts: sql`case when ${older} then ${m.parts} else ${m.parts} || ${JSON.stringify({ [part.id]: part })}::jsonb end` } })
          applied++
          break
        }
        case "message.removed": {
          const id = p.messageID as string | undefined
          if (id) await tx.delete(pgSchema.messages).where(and(eq(pgSchema.messages.id, id), eq(pgSchema.messages.userId, userId)))
          applied++
          break
        }
        case "message.part.removed": {
          const { messageID, partID } = p as { messageID?: string; partID?: string }
          if (messageID && partID) await tx.update(pgSchema.messages).set({ parts: sql`${pgSchema.messages.parts} - ${partID}` }).where(and(eq(pgSchema.messages.id, messageID), eq(pgSchema.messages.userId, userId)))
          applied++
          break
        }
        default:
          break
      }
    }
  })
  for (const id of revokedShares) invalidateShare(id)
  return { applied }
}

/**
 * The engine session of a workspace ended (stop, idle, cap, a new start): replies it never finished end here, marked
 * interrupted, and their running tool calls become errors, so history does not show them in progress forever.
 */
export async function interruptOpenReplies(tx: PgTx, userId: string, workspaceId: string, endAt: Date): Promise<void> {
  const m = pgSchema.messages
  const error = JSON.stringify({ error: { name: "MessageInterruptedError", data: { message: "The workspace stopped before this reply finished." } } })
  const toolError = JSON.stringify({ status: "error", error: "Interrupted: the workspace stopped before this step finished." })
  await tx
    .update(m)
    .set({
      completedAt: endAt,
      info: sql`coalesce(${m.info}, '{}'::jsonb) || ${error}::jsonb`,
      parts: sql`coalesce((select jsonb_object_agg(k, case when v ->> 'type' = 'tool' and v -> 'state' ->> 'status' in ('pending', 'running') then jsonb_set(v, '{state}', (v -> 'state') || ${toolError}::jsonb) else v end) from jsonb_each(${m.parts}) as e(k, v)), '{}'::jsonb)`,
    })
    .where(and(eq(m.userId, userId), eq(m.workspaceId, workspaceId), eq(m.role, "assistant"), isNull(m.completedAt), lte(m.createdAt, endAt)))
}

export async function recordRouterEvents(userId: string, workspaceId: string, events: RouterEvent[]): Promise<void> {
  if (!events.length) return
  await withUser(userId, async (tx) => {
    await tx
      .insert(pgSchema.routerEvents)
      .values(events.map((e) => ({ ...e, userId, workspaceId, ts: new Date(e.ts), retryAt: e.retryAt ? new Date(e.retryAt) : null })))
      .onConflictDoNothing()
  })
}

/** The user's router attempts since `sinceMs` across all their workspaces, oldest first, in the router's own event shape. */
export async function recentRouterEvents(userId: string, sinceMs: number, limit = 400): Promise<RouterEvent[]> {
  const r = pgSchema.routerEvents
  const rows = await withUser(userId, (tx) =>
    tx
      .select()
      .from(r)
      .where(and(eq(r.userId, userId), gte(r.ts, new Date(sinceMs))))
      .orderBy(asc(r.ts))
      .limit(limit),
  )
  return rows.map((x) => ({
    id: x.id,
    ts: x.ts.getTime(),
    alias: x.alias,
    providerId: x.providerId,
    modelId: x.modelId,
    keyId: x.keyId,
    tier: x.tier,
    status: x.status,
    httpStatus: x.httpStatus,
    attempts: x.attempts,
    latencyMs: x.latencyMs,
    inputTokens: x.inputTokens,
    outputTokens: x.outputTokens,
    cost: x.cost,
    error: x.error,
    sessionId: x.sessionId,
    ttftMs: x.ttftMs,
    retryAt: x.retryAt ? x.retryAt.getTime() : null,
    reason: x.reason,
  }))
}

/** Top-level chats across the user's live workspaces, newest first. Chats of deleted workspaces are left out. */
export async function listAllSessions(userId: string, limit = 300) {
  const cs = pgSchema.chatSessions
  const ws = pgSchema.workspaces
  return withUser(userId, (tx) =>
    tx
      .select({ id: cs.id, title: cs.title, workspaceId: cs.workspaceId, updatedAt: cs.updatedAt })
      .from(cs)
      .innerJoin(ws, eq(ws.id, cs.workspaceId))
      .where(and(eq(cs.userId, userId), isNull(cs.deletedAt), isNull(cs.parentId), isNull(ws.deletedAt)))
      .orderBy(desc(cs.updatedAt))
      .limit(limit),
  )
}

export async function listMessages(userId: string, sessionId: string) {
  return withUser(userId, (tx) => tx.select().from(pgSchema.messages).where(and(eq(pgSchema.messages.userId, userId), eq(pgSchema.messages.sessionId, sessionId))).orderBy(pgSchema.messages.createdAt))
}
