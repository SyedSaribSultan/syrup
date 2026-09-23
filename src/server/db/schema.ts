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

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})
