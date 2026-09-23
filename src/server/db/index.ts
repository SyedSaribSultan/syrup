import fs from "node:fs"
import path from "node:path"
import { createClient, type Client } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { env } from "../env"
import * as schema from "./schema"

type Db = ReturnType<typeof drizzle<typeof schema>>

// Cached on globalThis so Next.js dev HMR does not open a new connection per reload.
const g = globalThis as unknown as { __syrupDb?: Db; __syrupDbClient?: Client; __syrupDbReady?: Promise<void> }

function ensureDir(url: string) {
  if (!url.startsWith("file:")) return
  const file = url.slice("file:".length)
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
}

export function db(): Db {
  if (!g.__syrupDb) {
    ensureDir(env.dbUrl)
    g.__syrupDbClient = createClient({ url: env.dbUrl })
    g.__syrupDb = drizzle(g.__syrupDbClient, { schema })
  }
  return g.__syrupDb
}

/** Applies pending migrations from ./drizzle. Safe to call many times. */
export function dbReady(): Promise<void> {
  if (!g.__syrupDbReady) {
    g.__syrupDbReady = migrate(db(), { migrationsFolder: path.join(process.cwd(), "drizzle") })
  }
  return g.__syrupDbReady
}

export { schema }
