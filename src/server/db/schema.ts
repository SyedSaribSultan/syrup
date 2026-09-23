import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * One row per assistant message OpenCode produces. Cost and tokens come
 * straight from OpenCode's message object, not from our own estimate.
 * Rows are upserted as the message is updated, so the final values win.
 */
export const usageEvents = sqliteTable("usage_events", {
  messageId: text("message_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  agent: text("agent"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  reasoningTokens: integer("reasoning_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  /** USD as reported by OpenCode (0 for free models). */
  cost: real("cost").notNull().default(0),
  /** 1 when the model's list price is zero, so the dashboard can split free from paid. */
  free: integer("free").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
})

/** Provider API keys. Many per provider. Key material is encrypted at rest. */
export const providerKeys = sqliteTable("provider_keys", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  label: text("label").notNull(),
  /** AES-256-GCM ciphertext, base64. */
  secret: text("secret").notNull(),
  /** Last few characters, for display. */
  hint: text("hint").notNull().default(""),
  tier: text("tier", { enum: ["free", "paid"] }).notNull().default("free"),
  enabled: integer("enabled").notNull().default(1),
  /** 1 for the key currently written into the engine. One per provider. */
  active: integer("active").notNull().default(0),
  createdAt: integer("created_at").notNull(),
})

/**
 * One row per request the router forwarded. This is the real spend: the
 * engine sees "syrup/auto" at $0, the router knows which backend ran it.
 */
export const routerEvents = sqliteTable("router_events", {
  id: text("id").primaryKey(),
  ts: integer("ts").notNull(),
  alias: text("alias").notNull(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  keyId: text("key_id"),
  tier: text("tier", { enum: ["free", "paid"] }).notNull().default("free"),
  /** "ok" | "rate_limited" | "error" | "aborted" */
  status: text("status").notNull(),
  httpStatus: integer("http_status"),
  attempts: integer("attempts").notNull().default(1),
  latencyMs: integer("latency_ms").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  /** USD at list price, 0 when the key is on a free tier. */
  cost: real("cost").notNull().default(0),
  error: text("error"),
})

/**
 * Long-term memory. Searched through the FTS5 index `memories_fts`, which is
 * created and kept in sync by triggers in the migration (Drizzle cannot model
 * virtual tables).
 */
export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  /** "fact" | "preference" | "project" | "reference" | "note" */
  kind: text("kind").notNull().default("note"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  /** Comma-separated lowercase tags. */
  tags: text("tags").notNull().default(""),
  /** Session that created it, if any. */
  sessionId: text("session_id"),
  /** "agent" | "user" */
  source: text("source").notNull().default("agent"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

/** Structured application log. Every layer writes here; the Logs modal reads it. */
export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  /** "debug" | "info" | "warn" | "error" */
  level: text("level").notNull().default("info"),
  /** "boot" | "engine" | "router" | "mcp" | "memory" | "skills" | "providers" | "workspace" | "ledger" | "api" | "ui" */
  source: text("source").notNull(),
  event: text("event").notNull(),
  sessionId: text("session_id"),
  directory: text("directory"),
  /** JSON, secrets already redacted. */
  data: text("data"),
})

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})
