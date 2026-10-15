import fs from "node:fs"
import path from "node:path"
import { neonConfig, Pool } from "@neondatabase/serverless"
import { sql } from "drizzle-orm"
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless"
import { migrate } from "drizzle-orm/neon-serverless/migrator"
import ws from "ws"
import { env } from "../../env"
import * as schema from "./schema"

/**
 * Cloud database. Two roles, on purpose:
 * - DATABASE_URL: the `syrup_app` role, NOBYPASSRLS. Every request handler
 *   uses it, so row-level security is enforced by Postgres, not by us
 *   remembering a WHERE clause. Tenant queries run inside withUser(), which
 *   sets `app.user_id` for the transaction; outside it tenant tables return
 *   nothing (fail closed).
 * - DATABASE_URL_UNPOOLED: the Neon owner role (BYPASSRLS via neon_superuser).
 *   Used only for migrations and for explicit cross-tenant admin reads via
 *   pgAdmin(). Never for user-facing paths.
 *
 * Neon over WebSockets so real transactions work.
 */

export type PgDb = NeonDatabase<typeof schema>
export type PgTx = Parameters<Parameters<PgDb["transaction"]>[0]>[0]

const g = globalThis as unknown as { __syrupPg?: PgDb; __syrupPgAdmin?: PgDb; __syrupPgReady?: Promise<void> }

function connect(url: string): PgDb {
  if (typeof WebSocket === "undefined") neonConfig.webSocketConstructor = ws
  return drizzle(new Pool({ connectionString: url }), { schema })
}

/** App connection (RLS enforced). */
export function pg(): PgDb {
  if (!g.__syrupPg) {
    if (!env.databaseUrl) throw new Error("DATABASE_URL is not set")
    g.__syrupPg = connect(env.databaseUrl)
  }
  return g.__syrupPg
}

/** Owner connection (RLS bypassed). Admin aggregates and migrations only; every use is a deliberate exception. */
export function pgAdmin(): PgDb {
  if (!g.__syrupPgAdmin) {
    if (!env.databaseUrlUnpooled) throw new Error("DATABASE_URL_UNPOOLED is not set")
    g.__syrupPgAdmin = connect(env.databaseUrlUnpooled)
  }
  return g.__syrupPgAdmin
}

/**
 * True when the build already applied every migration this deploy carries (scripts/migrate-pg.mjs wrote
 * drizzle-pg/meta/applied.json naming the journal's last tag). A cheap file read instead of a database round trip.
 */
function migratedAtBuild(folder: string): boolean {
  try {
    const applied = JSON.parse(fs.readFileSync(path.join(folder, "meta", "applied.json"), "utf8")) as { tag?: string }
    const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] }
    return !!applied.tag && applied.tag === journal.entries.at(-1)?.tag
  } catch {
    return false
  }
}

/**
 * Ready to query. Deploys migrate at build time, so this resolves at once; without the build's marker (local cloud
 * testing, a build that could not reach the database) it applies pending migrations from ./drizzle-pg once per
 * process, as the owner role, as before.
 */
export function pgReady(): Promise<void> {
  if (!g.__syrupPgReady) {
    const folder = path.join(process.cwd(), "drizzle-pg")
    if (migratedAtBuild(folder)) return (g.__syrupPgReady = Promise.resolve())
    g.__syrupPgReady = migrate(pgAdmin(), { migrationsFolder: folder }).catch((err) => {
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
