import path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { sql } from "drizzle-orm"
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import * as schema from "../../../src/server/db/pg/schema"

/**
 * Stand-in for src/server/db/pg in scripts/test-cloud.mjs: the real migrations on an in-memory PGlite. withUser runs as
 * the NOBYPASSRLS role syrup_app (as production does), so forced row-level security applies; pg() and pgAdmin() run as
 * the owner. Same exports as the real module.
 */

export type PgDb = PgliteDatabase<typeof schema>
export type PgTx = Parameters<Parameters<PgDb["transaction"]>[0]>[0]

const g = globalThis as unknown as { __testPg?: PgDb; __testPgReady?: Promise<void> }

function db(): PgDb {
  return (g.__testPg ??= drizzle(new PGlite(), { schema }))
}

export function pg(): PgDb {
  return db()
}

export function pgAdmin(): PgDb {
  return db()
}

export function pgReady(): Promise<void> {
  return (g.__testPgReady ??= (async () => {
    await db().execute(sql`create role syrup_app nobypassrls`)
    await migrate(db(), { migrationsFolder: path.join(process.cwd(), "drizzle-pg") })
    await db().execute(sql`grant all on all tables in schema public to syrup_app`)
  })())
}

export async function withUser<T>(userId: string, fn: (tx: PgTx) => Promise<T>): Promise<T> {
  await pgReady()
  return db().transaction(async (tx) => {
    await tx.execute(sql`set local role syrup_app`)
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return fn(tx)
  })
}

export { schema as pgSchema }
