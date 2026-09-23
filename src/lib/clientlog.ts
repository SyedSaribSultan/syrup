"use client"

/**
 * Browser-side logging. Rows are batched and posted to /api/logs so they
 * land in the same table as server logs. Never blocks the UI.
 */

type Level = "debug" | "info" | "warn" | "error"
type Row = { ts: number; level: Level; event: string; data?: unknown; sessionId?: string | null; directory?: string | null }

let buf: Row[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let installed = false

function flush() {
  timer = undefined
  if (buf.length === 0) return
  const rows = buf
  buf = []
  void fetch("/api/logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rows), keepalive: true }).catch(() => {
    // Put them back so nothing is lost on a transient failure, but never grow without bound.
    buf = [...rows, ...buf].slice(-500)
  })
}

export function clog(event: string, data?: unknown, opts: { level?: Level; sessionId?: string | null; directory?: string | null } = {}) {
  buf.push({ ts: Date.now(), level: opts.level ?? "info", event, data: safe(data), sessionId: opts.sessionId ?? null, directory: opts.directory ?? null })
  if (buf.length >= 50) flush()
  else if (!timer) timer = setTimeout(flush, 2000)
}

function safe(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
  try {
    const s = JSON.stringify(v)
    return s && s.length > 8000 ? JSON.parse(s.slice(0, 8000) + '"') : v
  } catch {
    return String(v)
  }
}

/** Captures uncaught errors, rejections, and page lifecycle. Call once. */
export function installClientLogging() {
  if (installed || typeof window === "undefined") return
  installed = true
  window.addEventListener("error", (e) => clog("window.error", { message: e.message, file: e.filename, line: e.lineno, col: e.colno, error: e.error instanceof Error ? { name: e.error.name, message: e.error.message, stack: e.error.stack } : String(e.error) }, { level: "error" }))
  window.addEventListener("unhandledrejection", (e) => clog("window.unhandledrejection", e.reason instanceof Error ? { name: e.reason.name, message: e.reason.message, stack: e.reason.stack } : String(e.reason), { level: "error" }))
  window.addEventListener("pagehide", flush)
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush())
  clog("page.loaded", { url: location.pathname, ua: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}`, dark: matchMedia("(prefers-color-scheme: dark)").matches })
}
