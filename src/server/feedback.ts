import { and, eq } from "drizzle-orm"
import { db, dbReady, schema } from "./db"
import { pgReady, pgSchema, withUser } from "./db/pg"
import type { Owner } from "./shares"

/**
 * Thumbs up/down on agent replies, both modes. Local rows stay in the local
 * SQLite file; cloud rows are per user under RLS and feed the admin insights
 * and, for users who gave research consent, the research export.
 */

export type Rating = 1 | -1
export type FeedbackInput = {
  sessionId: string
  messageId: string
  /** 0 clears the rating. */
  rating: Rating | 0
  alias?: string | null
  providerId?: string | null
  modelId?: string | null
}

/** messageId → rating for one chat. */
export async function sessionRatings(owner: Owner, sessionId: string): Promise<Record<string, Rating>> {
  let rows: { messageId: string; rating: number }[]
  if (owner.mode === "local") {
    await dbReady()
    const f = schema.messageFeedback
    rows = await db().select({ messageId: f.messageId, rating: f.rating }).from(f).where(eq(f.sessionId, sessionId))
  } else {
    await pgReady()
    const f = pgSchema.messageFeedback
    rows = await withUser(owner.userId, (tx) => tx.select({ messageId: f.messageId, rating: f.rating }).from(f).where(and(eq(f.userId, owner.userId), eq(f.sessionId, sessionId))))
  }
  return Object.fromEntries(rows.map((r) => [r.messageId, r.rating > 0 ? 1 : -1]))
}

export async function setRating(owner: Owner, input: FeedbackInput): Promise<void> {
  const model = { alias: input.alias ?? null, providerId: input.providerId ?? null, modelId: input.modelId ?? null }
  if (owner.mode === "local") {
    await dbReady()
    const f = schema.messageFeedback
    if (input.rating === 0) {
      await db().delete(f).where(eq(f.messageId, input.messageId))
      return
    }
    const now = Date.now()
    await db()
      .insert(f)
      .values({ messageId: input.messageId, sessionId: input.sessionId, rating: input.rating, ...model, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: f.messageId, set: { rating: input.rating, ...model, updatedAt: now } })
    return
  }
  await pgReady()
  const f = pgSchema.messageFeedback
  await withUser(owner.userId, async (tx) => {
    if (input.rating === 0) {
      await tx.delete(f).where(and(eq(f.userId, owner.userId), eq(f.messageId, input.messageId)))
      return
    }
    await tx
      .insert(f)
      .values({ userId: owner.userId, messageId: input.messageId, sessionId: input.sessionId, rating: input.rating, ...model })
      .onConflictDoUpdate({ target: [f.userId, f.messageId], set: { rating: input.rating, ...model, updatedAt: new Date() } })
  })
}
