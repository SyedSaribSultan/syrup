import { sql } from "drizzle-orm"
import { pgAdmin, pgReady, pgSchema } from "../db/pg"

/**
 * Per-user fixed-window throttle on routes that cost money or fan out (audit 2026-11-17). Vercel's free tier has no
 * shared store, so the count lives in Postgres: one upsert per call on a row per (user, bucket, window). Signed-in
 * users only: anonymous requests never reach it, so a flood of them writes nothing here.
 * Throws a 429 Response, as the route handlers expect. Limits are sized well above honest use.
 */
export async function throttle(userId: string, bucket: string, max: number, windowSec: number): Promise<void> {
  await pgReady()
  const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec
  const c = pgSchema.rateCounters
  const [row] = await pgAdmin()
    .insert(c)
    .values({ userId, bucket, windowStart, n: 1 })
    .onConflictDoUpdate({ target: [c.userId, c.bucket, c.windowStart], set: { n: sql`${c.n} + 1` } })
    .returning({ n: c.n })
  if (row.n > max) {
    const retry = Math.max(1, windowStart + windowSec - Math.floor(Date.now() / 1000))
    throw Response.json({ error: "Too many requests. Try again in a little while.", code: "rate_limited" }, { status: 429, headers: { "retry-after": String(retry) } })
  }
}
