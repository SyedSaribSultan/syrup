"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useParams } from "next/navigation"
import { clog } from "@/lib/clientlog"
import { usePresence, type Presence } from "@/lib/use-presence"
import { useNarrow } from "@/lib/use-window-class"
import { Skel } from "./brew"
import { Sheet } from "./ui/sheet"

/** App-wide access to the Logs modal, so any page can open it. */
const LogsContext = createContext<{ open(): void } | null>(null)

export function LogsProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  const params = useParams<{ id?: string }>()
  const open = useCallback(() => setOpen(true), [])
  const close = useCallback(() => setOpen(false), [])
  // Fades in and out (docs/MOTION.md §5); an overlay, so a menu that opens it closes without its own exit (§4.3).
  const presence = usePresence<HTMLDivElement>(isOpen, { handoff: true })
  return (
    <LogsContext.Provider value={{ open }}>
      {children}
      {presence.mounted && <LogsModal sessionID={params?.id} onClose={close} presence={presence} />}
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
 * On phones rows go two-line and the filters move into a sheet (docs/RESPONSIVE.md §7).
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

export function LogsModal({ sessionID, onClose, presence }: { sessionID?: string; onClose(): void; presence?: Presence<HTMLDivElement> }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [engineTail, setEngineTail] = useState<string[]>([])
  const [sources, setSources] = useState<Set<string>>(new Set(SOURCES))
  const [minLevel, setMinLevel] = useState<"debug" | "info" | "warn">("debug")
  // Logs are app-wide; narrowing to the open chat is opt-in.
  const [onlySession, setOnlySession] = useState(false)
  const [q, setQ] = useState("")
  const [open, setOpen] = useState<number | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  // Phones and tablets: the filters live in a bottom sheet behind a Filters button.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const narrow = useNarrow()
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
    setLoaded(true)
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

  const toggleSource = (s: string) =>
    setSources((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  // How many filters differ from the defaults, shown on the phone's Filters button.
  const activeFilters = (q.trim() ? 1 : 0) + (minLevel !== "debug" ? 1 : 0) + (sources.size < SOURCES.length ? 1 : 0) + (onlySession && sessionID ? 1 : 0)

  /** The filter controls: a compact bar on desktop, roomier touch rows in the phone/tablet sheet. */
  const filters = (sheet: boolean) => (
    <>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search events and data…"
        className={`rounded-lg border border-line bg-surface outline-none placeholder:text-muted focus:border-line-2 ${sheet ? "min-h-11 w-full px-3 py-2" : "w-64 px-2.5 py-1.5"}`}
      />
      {sheet && <div className="mt-4 mb-1.5 text-[11px] font-medium tracking-wider text-muted uppercase">Level</div>}
      <div className={`flex rounded-lg border border-line bg-surface p-0.5 ${sheet ? "w-full" : ""}`}>
        {(["debug", "info", "warn"] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setMinLevel(l)}
            className={`rounded-md px-2 py-1 transition ${sheet ? "min-h-10 flex-1" : ""} ${minLevel === l ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}
          >
            {l === "debug" ? "everything" : l === "info" ? "info+" : "warnings+"}
          </button>
        ))}
      </div>
      {sheet && <div className="mt-4 mb-1.5 text-[11px] font-medium tracking-wider text-muted uppercase">Sources</div>}
      <div className={`flex flex-wrap ${sheet ? "gap-1.5" : "gap-1"}`}>
        {SOURCES.map((s) => {
          const on = sources.has(s)
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => toggleSource(s)}
              className={`rounded-md border transition ${sheet ? "min-h-10 px-3" : "px-1.5 py-0.5"} ${on ? "border-line-2 bg-surface-2 text-ink" : "border-line text-muted hover:text-ink"}`}
            >
              {s}
            </button>
          )
        })}
      </div>
      <div className={sheet ? "mt-3" : "contents"}>
        {sessionID && (
          <label className={`flex items-center text-ink-2 ${sheet ? "min-h-11 gap-2.5" : "gap-1.5"}`}>
            <input type="checkbox" checked={onlySession} onChange={(e) => setOnlySession(e.target.checked)} /> this session only
          </label>
        )}
        <label className={`flex items-center text-ink-2 ${sheet ? "min-h-11 gap-2.5" : "gap-1.5"}`}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> live
        </label>
      </div>
    </>
  )

  // Phones: title, Filters and ✕ on the first line, the counts under them, then the copy buttons.
  // From medium up it is today's single wrapping bar. `order-*` does the reshuffle, so the DOM stays one list.
  // Motion: the whole layer fades (motion-pop), base in and fast out; phones add a small rise. The blur radius never
  // animates (docs/MOTION.md §8): it stays as it is while the layer's opacity changes.
  return (
    <div
      {...presence?.props}
      data-side={narrow ? "up" : undefined}
      className="fixed inset-0 z-50 flex flex-col bg-bg/95 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] backdrop-blur-sm motion-pop"
      role="dialog"
      aria-modal="true"
      aria-label="Logs"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3 medium:px-5">
        <h2 className="order-1 font-serif text-[1.2rem] font-medium text-ink medium:order-none">Logs</h2>
        <span className="order-3 flex basis-full flex-wrap items-center gap-x-1 text-xs text-muted medium:order-none medium:basis-auto">
          {onlySession && sessionID ? "this chat" : "whole app"} · last 24h ·{" "}
          {loaded ? (
            <span>
              {rows.length} rows · <span className={counts.error ? "text-err" : ""}>{counts.error} errors</span> · <span className={counts.warn ? "text-warn" : ""}>{counts.warn} warnings</span>
            </span>
          ) : (
            <Skel className="h-3 w-44" />
          )}
        </span>
        <span className="order-1 flex-1 medium:order-none" />
        <div className="order-4 flex basis-full flex-wrap items-center gap-2 medium:order-none medium:basis-auto">
          <span className="text-xs text-muted medium:hidden">Copy</span>
          <CopyBtn onClick={() => copy("5m")} done={copied === "5m"} primary>
            <span className="medium:hidden">last 5 min</span>
            <span className="hidden medium:inline">Copy last 5 min</span>
          </CopyBtn>
          <CopyBtn onClick={() => copy("30m")} done={copied === "30m"}>
            <span className="medium:hidden">30 min</span>
            <span className="hidden medium:inline">Copy last 30 min</span>
          </CopyBtn>
          <CopyBtn onClick={() => copy("all")} done={copied === "all"}>
            <span className="medium:hidden">all shown</span>
            <span className="hidden medium:inline">Copy all shown</span>
          </CopyBtn>
        </div>
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          aria-haspopup="dialog"
          className="order-2 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-line-2 hover:text-ink pointer-coarse:min-h-11 pointer-coarse:px-3.5 medium:order-none expanded:hidden"
        >
          Filters{activeFilters > 0 && <span className="ml-1 text-accent">· {activeFilters}</span>}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="order-2 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-line-2 hover:text-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 medium:order-none medium:ml-2"
        >
          <span className="pointer-coarse:hidden">Esc </span>✕
        </button>
      </div>

      <div className="hidden shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-2 text-xs expanded:flex">{filters(false)}</div>
      <Sheet open={filtersOpen && narrow} onClose={() => setFiltersOpen(false)} title="Filters">
        <div className="px-5 pb-4 text-[13px]">
          {filters(true)}
          <button type="button" onClick={() => setFiltersOpen(false)} className="mt-4 min-h-11 w-full rounded-lg bg-surface-2 text-sm font-medium text-ink transition hover:bg-line">
            Done
          </button>
        </div>
      </Sheet>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)] font-mono text-[12px]">
        {!loaded && <LogSkeleton />}
        {loaded && rows.length === 0 && <div className="p-8 text-center font-sans text-sm text-muted">No log rows match.</div>}
        {rows.map((r) => {
          const isOpen = open === r.id
          return (
            <div key={r.id} className="border-b border-line/60">
              {/* Phones: two lines (time · level · source, then event and data). From medium up: fixed columns. */}
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : r.id)}
                className="block w-full px-4 py-2 text-left hover:bg-surface/70 medium:flex medium:items-start medium:gap-3 medium:px-5 medium:py-1.5"
              >
                <span className="flex items-center gap-2 medium:contents">
                  <span className="tabular-nums text-muted medium:w-[86px] medium:shrink-0">
                    {new Date(r.ts).toLocaleTimeString(undefined, { hour12: false })}.{String(r.ts % 1000).padStart(3, "0")}
                  </span>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full medium:mt-1.5 ${LEVEL_DOT[r.level] ?? "bg-muted"}`} title={r.level} />
                  <span className={`medium:hidden ${r.level === "error" ? "text-err" : r.level === "warn" ? "text-warn" : "text-muted"}`}>{r.level}</span>
                  <span className="text-ink-2 medium:w-[72px] medium:shrink-0">{r.source}</span>
                </span>
                <span className="mt-0.5 block truncate medium:contents">
                  <span className="text-ink medium:w-[220px] medium:shrink-0 medium:truncate">{r.event}</span>{" "}
                  <span className="text-muted medium:min-w-0 medium:flex-1 medium:truncate">{summary(r)}</span>
                </span>
              </button>
              {isOpen && (
                <div className="bg-code-bg px-4 py-3 medium:px-5">
                  <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                    <span>{new Date(r.ts).toISOString()}</span>
                    <span>level={r.level}</span>
                    {r.sessionId && <span className="break-all">session={r.sessionId}</span>}
                    {r.directory && <span className="break-all">dir={r.directory}</span>}
                    <span>id={r.id}</span>
                  </div>
                  <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words text-ink-2">{pretty(r.data) || "(no data)"}</pre>
                </div>
              )}
            </div>
          )
        })}
        {engineTail.length > 0 && (
          <details className="border-t border-line">
            <summary className="cursor-pointer px-4 py-2 font-sans text-xs text-ink-2 hover:text-ink pointer-coarse:py-3.5 medium:px-5">
              OpenCode engine log — last {engineTail.length} lines (raw, included in copies)
            </summary>
            <pre className="max-h-[40vh] overflow-auto bg-code-bg px-4 py-3 whitespace-pre-wrap break-words text-[11px] text-muted medium:px-5">{engineTail.join("\n")}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

const SKEL_WIDTHS = ["62%", "48%", "71%", "39%", "55%", "66%", "44%", "58%", "35%", "69%", "51%", "42%"]

/** Rows shaped like log lines, so the columns are already where the real ones land (two lines on phones). */
function LogSkeleton() {
  return (
    <div aria-busy className="skel-in">
      {SKEL_WIDTHS.map((w, i) => (
        <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/60 px-4 py-[11px] medium:flex-nowrap medium:px-5 medium:py-[7px]">
          <Skel className="h-3 w-[86px] shrink-0" />
          <Skel className="h-1.5 w-1.5 shrink-0 rounded-full" />
          <Skel className="h-3 w-[56px] shrink-0" />
          <Skel className="hidden h-3 w-[160px] shrink-0 medium:block" />
          <span className="block min-w-0 basis-full medium:basis-auto" style={{ width: w }}>
            <Skel className="h-3" />
          </span>
        </div>
      ))}
    </div>
  )
}

function CopyBtn({ children, onClick, done, primary }: { children: React.ReactNode; onClick(): void; done: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition pointer-coarse:min-h-11 ${primary ? "bg-accent text-accent-ink" : "border border-line text-ink-2 hover:border-line-2 hover:text-ink"}`}
    >
      {done ? "Copied ✓" : children}
    </button>
  )
}
