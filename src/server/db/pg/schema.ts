import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { AdapterAccountType } from "next-auth/adapters"

/**
 * Cloud schema (Postgres). Conventions from docs/PLAN.md §5:
 * ULID text ids, timestamptz, user_id on every tenant table, soft delete via
 * deleted_at. Row-level security for tenant tables is set up in
 * drizzle-pg/0001_rls.sql (Drizzle generates the tables, the policies are
 * hand-written there).
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

// ---------------------------------------------------------------- identity (Auth.js)

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: ts("email_verified"),
  image: text("image"),
  plan: text("plan").notNull().default("free"),
  /** Product analytics opt-out (PLAN §6 layer B). */
  analyticsOptOut: boolean("analytics_opt_out").notNull().default(false),
  /** GitHub fine-grained token for private repos, AES-GCM under the user's DEK (S5). */
  githubTokenEnc: text("github_token_enc"),
  githubTokenHint: text("github_token_hint"),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at"),
  deletedAt: ts("deleted_at"),
})

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] }), index("accounts_user_idx").on(t.userId)],
)

/** Kept for Auth.js adapter compatibility; sessions are JWT cookies, so this stays empty. */
export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: ts("expires").notNull(),
})

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: ts("expires").notNull(),
}, (t) => [primaryKey({ columns: [t.identifier, t.token] })])

/** One data-encryption key per user, wrapped by SYRUP_MASTER_KEY (envelope encryption, PLAN §3.4). */
export const userKeys = pgTable("user_keys", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** AES-256-GCM(master, dek), base64: iv | tag | ciphertext. */
  dekWrapped: text("dek_wrapped").notNull(),
  wrapVersion: integer("wrap_version").notNull().default(1),
  createdAt: ts("created_at").notNull().defaultNow(),
})

// ---------------------------------------------------------------- access

/** Sign-in succeeds only for an email with an open invite, an existing user, or an admin. */
export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  invitedBy: text("invited_by"),
  note: text("note"),
  createdAt: ts("created_at").notNull().defaultNow(),
  acceptedAt: ts("accepted_at"),
  revokedAt: ts("revoked_at"),
}, (t) => [uniqueIndex("invites_email_idx").on(t.email)])

// ---------------------------------------------------------------- providers

export const providerKeys = pgTable("provider_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  label: text("label").notNull(),
  /** AES-256-GCM under the user's DEK, base64. */
  secretEnc: text("secret_enc").notNull(),
  hint: text("hint").notNull().default(""),
  tier: text("tier", { enum: ["free", "paid"] }).notNull().default("free"),
  enabled: boolean("enabled").notNull().default(true),
  active: boolean("active").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastUsedAt: ts("last_used_at"),
}, (t) => [index("provider_keys_user_idx").on(t.userId, t.providerId)])

// ---------------------------------------------------------------- trust, safety, legal

export const legalDocuments = pgTable("legal_documents", {
  id: text("id").primaryKey(),
  /** "terms" | "privacy" | "research" | "cookies" */
  kind: text("kind").notNull(),
  version: text("version").notNull(),
  contentHash: text("content_hash").notNull(),
  publishedAt: ts("published_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("legal_kind_version_idx").on(t.kind, t.version)])

/** Append-only. Current consent for a kind = latest row for that kind with no revoked_at. */
export const consents = pgTable("consents", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  legalDocumentId: text("legal_document_id")
    .notNull()
    .references(() => legalDocuments.id),
  kind: text("kind").notNull(),
  grantedAt: ts("granted_at").notNull().defaultNow(),
  revokedAt: ts("revoked_at"),
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
}, (t) => [index("consents_user_kind_idx").on(t.userId, t.kind, t.grantedAt)])

export const dataRequests = pgTable("data_requests", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** "export" | "delete" */
  type: text("type").notNull(),
  /** "requested" | "running" | "done" | "failed" */
  status: text("status").notNull().default("requested"),
  requestedAt: ts("requested_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
  downloadUrlEnc: text("download_url_enc"),
  expiresAt: ts("expires_at"),
}, (t) => [index("data_requests_user_idx").on(t.userId, t.requestedAt)])

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  /** "user" | "system" | "admin" */
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  data: jsonb("data"),
  ipHash: text("ip_hash"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("audit_user_idx").on(t.userId, t.createdAt)])

// ---------------------------------------------------------------- operations

export const logs = pgTable("logs", {
  id: text("id").primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  level: text("level").notNull().default("info"),
  source: text("source").notNull(),
  event: text("event").notNull(),
  userId: text("user_id"),
  workspaceId: text("workspace_id"),
  data: jsonb("data"),
}, (t) => [index("logs_ts_idx").on(t.ts), index("logs_user_idx").on(t.userId, t.ts)])

// ---------------------------------------------------------------- workspaces and compute (Phase 2)

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** "git" | "empty" */
  source: text("source").notNull().default("empty"),
  repoUrl: text("repo_url"),
  defaultBranch: text("default_branch"),
  /** Extra egress hosts the user allowed for this workspace. */
  egressAllow: text("egress_allow").array().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastOpenedAt: ts("last_opened_at"),
  deletedAt: ts("deleted_at"),
}, (t) => [index("workspaces_user_idx").on(t.userId, t.lastOpenedAt)])

/** One Vercel Sandbox per workspace. The row is the durable record; the VM is disposable. */
export const sandboxes = pgTable("sandboxes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  vercelName: text("vercel_name").notNull(),
  region: text("region").notNull().default("fra1"),
  /** "stopped" | "starting" | "running" | "error" */
  status: text("status").notNull().default("stopped"),
  /** OpenCode server password, AES-GCM under the user's DEK. Rotated whenever the engine is (re)started. */
  passwordEnc: text("password_enc"),
  vcpus: integer("vcpus").notNull().default(1),
  engineVersion: text("engine_version"),
  lastSessionStartedAt: ts("last_session_started_at"),
  lastSessionEndedAt: ts("last_session_ended_at"),
  totalSessionSeconds: integer("total_session_seconds").notNull().default(0),
  totalCpuMs: integer("total_cpu_ms").notNull().default(0),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("sandboxes_workspace_idx").on(t.workspaceId), index("sandboxes_user_idx").on(t.userId)])

// ---------------------------------------------------------------- history (Phase 2, S3)

/** One row per OpenCode session; `id` is the engine's session id. */
export const chatSessions = pgTable("chat_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  parentId: text("parent_id"),
  title: text("title"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  archivedAt: ts("archived_at"),
  deletedAt: ts("deleted_at"),
}, (t) => [index("chat_sessions_user_idx").on(t.userId, t.workspaceId, t.updatedAt)])

/** One row per engine message; `parts` holds the final parts keyed by part id (the full record, PLAN §5). */
export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  providerId: text("provider_id"),
  modelId: text("model_id"),
  agent: text("agent"),
  info: jsonb("info"),
  parts: jsonb("parts").notNull().default({}),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  reasoningTokens: integer("reasoning_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  cost: real("cost").notNull().default(0),
  free: boolean("free").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
}, (t) => [index("messages_session_idx").on(t.sessionId, t.createdAt), index("messages_user_idx").on(t.userId, t.createdAt)])

/** Router attempts from sandbox sidecars: the real spend (PLAN §5). */
export const routerEvents = pgTable("router_events", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  ts: ts("ts").notNull(),
  alias: text("alias").notNull(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  keyId: text("key_id"),
  tier: text("tier", { enum: ["free", "paid"] }).notNull().default("free"),
  status: text("status").notNull(),
  httpStatus: integer("http_status"),
  attempts: integer("attempts").notNull().default(1),
  latencyMs: integer("latency_ms").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cost: real("cost").notNull().default(0),
  error: text("error"),
}, (t) => [index("router_events_user_idx").on(t.userId, t.ts)])

/** Long-term memory (cloud). Full-text search over title, content and tags via the `search` column (added in the RLS migration). */
export const memories = pgTable("memories", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Null = shared across the user's workspaces. */
  workspaceId: text("workspace_id"),
  kind: text("kind").notNull().default("note"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: text("tags").array().notNull().default([]),
  /** "agent" | "user" */
  source: text("source").notNull().default("agent"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [index("memories_user_idx").on(t.userId, t.updatedAt)])
