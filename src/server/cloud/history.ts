import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { pgSchema, withUser } from "../db/pg"
import type { RouterEvent } from "../router/store"

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

export async function applyEvents(userId: string, workspaceId: string, events: EngineEvent[]): Promise<{ applied: number }> {
  let applied = 0
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
            .onConflictDoUpdate({ target: pgSchema.chatSessions.id, set: { title: info.title ?? null, updatedAt: ms(info.time?.updated) ?? new Date() } })
          applied++
          break
        }
        case "session.deleted": {
          const info = p.info as SessionInfo | undefined
          if (!info?.id) break
          await tx.update(pgSchema.chatSessions).set({ deletedAt: new Date() }).where(and(eq(pgSchema.chatSessions.id, info.id), eq(pgSchema.chatSessions.userId, userId)))
          applied++
          break
        }
        case "message.updated": {
          const info = p.info as MessageInfo | undefined
          if (!info?.id || !info.sessionID) break
          // A message can arrive before its session event; make sure the session row exists.
          await tx.insert(pgSchema.chatSessions).values({ id: info.sessionID, userId, workspaceId }).onConflictDoNothing()
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
          await tx.insert(pgSchema.messages).values(row).onConflictDoUpdate({ target: pgSchema.messages.id, set })
          await tx.update(pgSchema.chatSessions).set({ updatedAt: new Date() }).where(eq(pgSchema.chatSessions.id, info.sessionID))
          applied++
          break
        }
        case "message.part.updated": {
          const part = p.part as PartInfo | undefined
          if (!part?.id || !part.messageID) break
          // Merge this part into the message's parts object (jsonb concatenation keeps the others).
          await tx.insert(pgSchema.chatSessions).values({ id: part.sessionID, userId, workspaceId }).onConflictDoNothing()
          await tx
            .insert(pgSchema.messages)
            .values({ id: part.messageID, userId, workspaceId, sessionId: part.sessionID, role: "unknown", parts: { [part.id]: part } })
            .onConflictDoUpdate({ target: pgSchema.messages.id, set: { parts: sql`${pgSchema.messages.parts} || ${JSON.stringify({ [part.id]: part })}::jsonb` } })
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
  return { applied }
}

export async function recordRouterEvents(userId: string, workspaceId: string, events: RouterEvent[]): Promise<void> {
  if (!events.length) return
  await withUser(userId, async (tx) => {
    await tx
      .insert(pgSchema.routerEvents)
      .values(events.map((e) => ({ ...e, userId, workspaceId, ts: new Date(e.ts) })))
      .onConflictDoNothing()
  })
}

export async function listSessions(userId: string, workspaceId: string, limit = 200) {
  return withUser(userId, (tx) =>
    tx
      .select()
      .from(pgSchema.chatSessions)
      .where(and(eq(pgSchema.chatSessions.userId, userId), eq(pgSchema.chatSessions.workspaceId, workspaceId), isNull(pgSchema.chatSessions.deletedAt), isNull(pgSchema.chatSessions.parentId)))
      .orderBy(desc(pgSchema.chatSessions.updatedAt))
      .limit(limit),
  )
}

export async function listMessages(userId: string, sessionId: string) {
  return withUser(userId, (tx) => tx.select().from(pgSchema.messages).where(and(eq(pgSchema.messages.userId, userId), eq(pgSchema.messages.sessionId, sessionId))).orderBy(pgSchema.messages.createdAt))
}
