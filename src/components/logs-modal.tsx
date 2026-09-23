"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useParams } from "next/navigation"
import { clog } from "@/lib/clientlog"

/** App-wide access to the Logs modal, so any page can open it. */
const LogsContext = createContext<{ open(): void } | null>(null)

export function LogsProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  const params = useParams<{ id?: string }>()
  const open = useCallback(() => setOpen(true), [])
  const close = useCallback(() => setOpen(false), [])
  return (
    <LogsContext.Provider value={{ open }}>
      {children}
      {isOpen && <LogsModal sessionID={params?.id} onClose={close} />}
    </LogsContext.Provider>
  )
}

export function useLogs() {
  const ctx = useContext(LogsContext)
  if (!ctx) throw new Error("useLogs outside LogsProvider")
  return ctx
}

/**
 * Full-screen log viewer. Simple list, click a row for the full record,
 * filters at the top, copy buttons for the ranges that matter when debugging.
 */

type Row = { id: number; ts: number; level: string; source: string; event: string; sessionId: string | null; directory: string | null; data: string | null }

const SOURCES = ["engine", "router", "mcp", "memory", "skills", "providers", "workspace", "ledger", "api", "ui", "boot"] as const
const LEVEL_DOT: Record<string, string> = { debug: "bg-line-2", info: "bg-ok", warn: "bg-warn", error: "bg-err" }

function summary(r: Row): string {
  if (!r.data) return ""
  try {
    const d = JSON.parse(r.data)
    if (typeof d !== "object" || d === null) return String(d)
    const keys = ["backend", "tool", "status", "httpStatus", "ms", "alias", "message", "error", "title", "name", "providerID", "modelID", "id", "chars", "url"]
    const bits: string[] = []
    for (const k of keys) {
      if (k in d && d[k] !== undefined && d[k] !== null && typeof d[k] !== "object") bits.push(`${k}=${String(d[k]).slice(0, 80)}`)
      if (bits.length >= 5) break
    }
    return bits.join("  ") || r.data.slice(0, 140)
  } catch {
    return r.data.slice(0, 140)
  }
}

function pretty(s: string | null): string {
  if (!s) return ""
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

export function LogsModal({ sessionID, onClose }: { sessionID?: string; onClose(): void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [engineTail, setEngineTail] = useState<string[]>([])
  const [sources, setSources] = useState<Set<string>>(new Set(SOURCES))
  const [minLevel, setMinLevel] = useState<"debug" | "info" | "warn">("debug")
  // Logs are app-wide; narrowing to the open chat is opt-in.
  const [onlySession, setOnlySession] = useState(false)
  const [q, setQ] = useState("")
  const [open, setOpen] = useState<number | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  const levels = minLevel === "debug" ? "" : minLevel === "info" ? "info,warn,error" : "warn,error"

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: "3000", engine: "1" })
    if (levels) p.set("levels", levels)
    if (sources.size < SOURCES.length) p.set("sources", [...sources].join(","))
    if (onlySession && sessionID) p.set("session", sessionID)
    if (q.trim()) p.set("q", q.trim())
    p.set("since", String(Date.now() - 24 * 3_600_000))
    const r = await fetch(`/api/logs?${p}`, { cache: "no-store" })
    const j = await r.json()
    setRows(j.rows ?? [])
    setEngineTail(j.engineTail ?? [])
  }, [levels, sources, onlySession, sessionID, q])

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [live, load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    clog("logs.opened", { sessionID })
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [onClose, sessionID])

  async function copy(range: "5m" | "30m" | "all") {
    const since = range === "5m" ? Date.now() - 5 * 60_000 : range === "30m" ? Date.now() - 30 * 60_000 : Date.now() - 24 * 3_600_000
    const p = new URLSearchParams({ format: "text", limit: "10000", engine: "1", since: String(since) })
    if (levels) p.set("levels", levels)
    if (sources.size < SOURCES.length) p.set("sources", [...sources].join(","))
    if (onlySession && sessionID) p.set("session", sessionID)
    if (q.trim()) p.set("q", q.trim())
    const r = await fetch(`/api/logs?${p}`, { cache: "no-store" })
    const text = await r.text()
    const context = [
      `# syrup ${range === "all" ? "all logs (24h)" : `last ${range}`}`,
      `# page ${location.href}`,
      `# session ${sessionID ?? "-"}`,
      `# browser ${navigator.userAgent}`,
      `# local time ${new Date().toString()}`,
      "",
    ].join("\n")
    try {
      await navigator.clipboard.writeText(context + text)
      setCopied(range)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // Clipboard blocked (non-secure context): download instead.
      const blob = new Blob([context + text], { type: "text/plain" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `syrup-logs-${range}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`
      a.click()
    }
    clog("logs.copied", { range, chars: text.length })
  }

  const counts = useMemo(() => {
    const c = { warn: 0, error: 0 }
    for (const r of rows) if (r.level === "warn") c.warn++
    for (const r of rows) if (r.level === "error") c.error++
    return c
  }, [rows])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Logs">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <h2 className="font-serif text-[1.2rem] font-medium text-ink">Logs</h2>
        <span className="text-xs text-muted">
          {onlySession && sessionID ? "this chat" : "whole app"} · last 24h · {rows.length} rows · <span className={counts.error ? "text-err" : ""}>{counts.error} errors</span> ·{" "}
          <span className={counts.warn ? "text-warn" : ""}>{counts.warn} warnings</span>
        </span>
        <span className="flex-1" />
        <CopyBtn onClick={() => copy("5m")} done={copied === "5m"} primary>
          Copy last 5 min
        </CopyBtn>
        <CopyBtn onClick={() => copy("30m")} done={copied === "30m"}>
          Copy last 30 min
        </CopyBtn>
        <CopyBtn onClick={() => copy("all")} done={copied === "all"}>
          Copy all shown
        </CopyBtn>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-2 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-line-2 hover:text-ink">
          Esc ✕
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-2 text-xs">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events and data…" className="w-64 rounded-lg border border-line bg-surface px-2.5 py-1.5 outline-none placeholder:text-muted focus:border-line-2" />
        <div className="flex rounded-lg border border-line bg-surface p-0.5">
          {(["debug", "info", "warn"] as const).map((l) => (
            <button key={l} type="button" onClick={() => setMinLevel(l)} className={`rounded-md px-2 py-1 transition ${minLevel === l ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
              {l === "debug" ? "everything" : l === "info" ? "info+" : "warnings+"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {SOURCES.map((s) => {
            const on = sources.has(s)
            return (
              <button
                key={s}
                type="button"
                onClick={() =>
                  setSources((prev) => {
                    const next = new Set(prev)
                    if (on) next.delete(s)
                    else next.add(s)
                    return next
                  })
                }
                className={`rounded-md border px-1.5 py-0.5 transition ${on ? "border-line-2 bg-surface-2 text-ink" : "border-line text-muted hover:text-ink"}`}
              >
                {s}
              </button>
            )
          })}
        </div>
        {sessionID && (
          <label className="flex items-center gap-1.5 text-ink-2">
            <input type="checkbox" checked={onlySession} onChange={(e) => setOnlySession(e.target.checked)} /> this session only
          </label>
        )}
        <label className="flex items-center gap-1.5 text-ink-2">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> live
        </label>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto font-mono text-[12px]">
        {rows.length === 0 && <div className="p-8 text-center font-sans text-sm text-muted">No log rows match.</div>}
        {rows.map((r) => {
          const isOpen = open === r.id
          return (
            <div key={r.id} className="border-b border-line/60">
              <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} className="flex w-full items-start gap-3 px-5 py-1.5 text-left hover:bg-surface/70">
                <span className="w-[86px] shrink-0 tabular-nums text-muted">{new Date(r.ts).toLocaleTimeString(undefined, { hour12: false })}.{String(r.ts % 1000).padStart(3, "0")}</span>
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[r.level] ?? "bg-muted"}`} title={r.level} />
                <span className="w-[72px] shrink-0 text-ink-2">{r.source}</span>
                <span className="w-[220px] shrink-0 truncate text-ink">{r.event}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{summary(r)}</span>
              </button>
              {isOpen && (
                <div className="bg-code-bg px-5 py-3">
                  <div className="mb-2 flex flex-wrap gap-4 text-[11px] text-muted">
                    <span>{new Date(r.ts).toISOString()}</span>
                    <span>level={r.level}</span>
                    {r.sessionId && <span>session={r.sessionId}</span>}
                    {r.directory && <span>dir={r.directory}</span>}
                    <span>id={r.id}</span>
                  </div>
                  <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap text-ink-2">{pretty(r.data) || "(no data)"}</pre>
                </div>
              )}
            </div>
          )
        })}
        {engineTail.length > 0 && (
          <details className="border-t border-line">
            <summary className="cursor-pointer px-5 py-2 font-sans text-xs text-ink-2 hover:text-ink">OpenCode engine log — last {engineTail.length} lines (raw, included in copies)</summary>
            <pre className="max-h-[40vh] overflow-auto bg-code-bg px-5 py-3 whitespace-pre-wrap text-[11px] text-muted">{engineTail.join("\n")}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

function CopyBtn({ children, onClick, done, primary }: { children: React.ReactNode; onClick(): void; done: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${primary ? "bg-accent text-accent-ink" : "border border-line text-ink-2 hover:border-line-2 hover:text-ink"}`}
    >
      {done ? "Copied ✓" : children}
    </button>
  )
}
