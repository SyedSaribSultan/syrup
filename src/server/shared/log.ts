/**
 * Logger contract shared by code that runs both in the syrup server (where it
 * is backed by slog → SQLite/Postgres) and inside the sandbox sidecar (where it
 * is forwarded to /api/ingest). Keeps the router and memory cores free of any
 * storage import.
 */
export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogSource = "boot" | "engine" | "router" | "mcp" | "memory" | "skills" | "providers" | "workspace" | "ledger" | "api" | "ui" | "sidecar"

export type Log = (source: LogSource, event: string, data?: unknown, opts?: { level?: LogLevel; sessionId?: string | null; directory?: string | null; ts?: number }) => void
