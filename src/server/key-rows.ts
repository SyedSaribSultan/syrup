import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { db, dbReady, schema } from "./db"
import { env } from "./env"

type Db = ReturnType<typeof drizzle<typeof schema>>
const g = globalThis as unknown as { __syrupKeysDb?: Promise<Db> }

/**
 * The database that holds the local provider keys: the app's own, or the one SYRUP_KEYS_DB names
 * (a borrowed vault, env.ts). A borrowed one is only ever read: no migrations, and SQLite itself refuses
 * writes (PRAGMA query_only; libsql rejects ?mode=ro). Its rows still need the matching vault.key
 * (SYRUP_VAULT_HOME) to open.
 */
export async function keysDb(): Promise<Db> {
  if (!env.keysDbUrl) {
    await dbReady()
    return db()
  }
  const url = env.keysDbUrl
  g.__syrupKeysDb ??= (async () => {
    const client = createClient({ url })
    await client.execute("PRAGMA query_only = ON")
    return drizzle(client, { schema })
  })()
  return g.__syrupKeysDb
}
