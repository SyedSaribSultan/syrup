import { defineConfig } from "drizzle-kit"

/** Cloud database (Neon Postgres). The SQLite config for local mode is drizzle.config.ts. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/pg/schema.ts",
  out: "./drizzle-pg",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "postgresql://localhost/syrup" },
})
