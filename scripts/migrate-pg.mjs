/**
 * Applies the Postgres migrations (./drizzle-pg) at build time, so no request waits for them (audit 2026-10-15 M4:
 * every cold instance used to run drizzle's migrate() on its first database touch, anonymous /signin included).
 *
 *   node scripts/migrate-pg.mjs        (part of `pnpm build`)
 *
 * Runs only in a Vercel build in cloud mode with a database URL; anywhere else (local builds, CI) it does nothing.
 * On success it writes drizzle-pg/meta/applied.json naming the last migration applied; at runtime pgReady() skips
 * migrate() when that matches the journal, and falls back to migrating as before when it does not (or is missing).
 * A failed migration fails the build, so a deploy never goes live on a schema it does not have.
 * Prints no connection string.
 */
import fs from "node:fs"
import path from "node:path"
import { neonConfig, Pool } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-serverless"
import { migrate } from "drizzle-orm/neon-serverless/migrator"
import ws from "ws"

const folder = path.join(process.cwd(), "drizzle-pg")
const marker = path.join(folder, "meta", "applied.json")
fs.rmSync(marker, { force: true })

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
const cloud = process.env.SYRUP_MODE ? process.env.SYRUP_MODE === "cloud" : !!process.env.VERCEL
if (!process.env.VERCEL || !cloud || !url) {
  console.log("[migrate-pg] skipped (not a Vercel cloud build with a database URL); migrations run on first use")
  process.exit(0)
}

const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"))
const last = journal.entries.at(-1)?.tag ?? null
neonConfig.webSocketConstructor = ws
const pool = new Pool({ connectionString: url })
const t0 = Date.now()
try {
  await migrate(drizzle(pool), { migrationsFolder: folder })
  fs.writeFileSync(marker, JSON.stringify({ tag: last, at: new Date().toISOString() }) + "\n")
  console.log(`[migrate-pg] applied through ${last} in ${Date.now() - t0} ms`)
} catch (err) {
  console.error("[migrate-pg] migration failed:", err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await pool.end()
}
