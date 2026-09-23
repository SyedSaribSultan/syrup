import path from "node:path"
import { neonConfig, Pool } from "@neondatabase/serverless"
import { sql } from "drizzle-orm"
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless"
import { migrate } from "drizzle-orm/neon-serverless/migrator"
import ws from "ws"
import { env } from "../../env"
import * as schema from "./schema"

/**
 * Cloud database. Neon over WebSockets so real transactions work: every
 * tenant query runs inside withUser(), which sets `app.user_id` for the
 * transaction and lets the row-level-security policies do the filtering.
 */

export type PgDb = NeonDatabase<typeof schema>
export type PgTx = Parameters<Parameters<PgDb["transaction"]>[0]>[0]

const g = globalThis as unknown as { __syrupPg?: PgDb; __syrupPgReady?: Promise<void> }

export function pg(): PgDb {
  if (!g.__syrupPg) {
    if (!env.databaseUrl) throw new Error("DATABASE_URL is not set")
    if (typeof WebSocket === "undefined") neonConfig.webSocketConstructor = ws
    const pool = new Pool({ connectionString: env.databaseUrl })
    g.__syrupPg = drizzle(pool, { schema })
  }
  return g.__syrupPg
}

/** Applies pending migrations from ./drizzle-pg once per process. */
export function pgReady(): Promise<void> {
  if (!g.__syrupPgReady) {
    g.__syrupPgReady = migrate(pg(), { migrationsFolder: path.join(process.cwd(), "drizzle-pg") }).catch((err) => {
      g.__syrupPgReady = undefined
      throw err
    })
  }
  return g.__syrupPgReady
}

/**
 * Runs fn in a transaction scoped to one user. RLS policies read
 * current_setting('app.user_id'); outside this wrapper tenant tables return
 * no rows, so a forgotten scope fails closed instead of leaking.
 */
export async function withUser<T>(userId: string, fn: (tx: PgTx) => Promise<T>): Promise<T> {
  await pgReady()
  return pg().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return fn(tx)
  })
}

export { schema as pgSchema }
