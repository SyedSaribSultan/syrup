import type { Log, LogLevel } from "../src/server/shared/log"
import { ingest, type SidecarConfig } from "./store-http"

type Row = { ts: number; level: LogLevel; source: string; event: string; data: unknown; sessionId: string | null }

const SECRET_KEYS = /^(api[_-]?key|authorization|secret|token|password|key)$/i

/** Same redaction rules as the server's log.ts, so nothing key-shaped leaves the VM. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]"
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 6).join("\n") }
  if (typeof value === "string") return value.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/g, "$1[redacted]").replace(/\b(AIza|gsk_|sk-|or-|nvapi-)[A-Za-z0-9_\-]{8,}/g, "$1[redacted]")
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) && typeof v === "string" ? (v.length > 8 ? `…${v.slice(-4)}` : "[redacted]") : redact(v, depth + 1)
    return out
  }
  return value
}

/** Buffers log rows and ships them to /api/ingest/logs every second. Never throws into the caller. */
export class HttpLog {
  private buf: Row[] = []
  private timer: NodeJS.Timeout | undefined
  constructor(private cfg: SidecarConfig) {}

  fn: Log = (source, event, data, opts = {}) => {
    const level = opts.level ?? "info"
    this.buf.push({ ts: opts.ts ?? Date.now(), level, source, event, data: data === undefined ? null : redact(data), sessionId: opts.sessionId ?? null })
    if (level === "error" || level === "warn") console[level === "error" ? "error" : "warn"](`[sidecar:${source}] ${event}`, data instanceof Error ? data.message : "")
    if (this.buf.length >= 200) void this.flush()
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 1000)
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const rows = this.buf.splice(0, 500)
    if (rows.length === 0) return
    try {
      await ingest(this.cfg, "/api/ingest/logs", { rows })
    } catch (err) {
      console.warn("[sidecar] log flush failed", err instanceof Error ? err.message : err)
    }
  }
}
