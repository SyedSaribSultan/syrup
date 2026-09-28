"use client"

import { useParams } from "next/navigation"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useOptionalEngine } from "@/lib/engine-store"
import { copyText } from "@/lib/file-actions"
import { fmtRelative } from "@/lib/format"
import type { ShareInfo } from "@/lib/share-link"
import type { Transcript } from "@/lib/transcript"
import { useDismiss } from "@/lib/use-dismiss"
import { useWorkspaces } from "@/lib/workspaces"
import { Brew, Skel } from "./brew"

/**
 * Share button for the chat header, the same in both modes: a public,
 * view-only link to a snapshot of the chat (src/server/shares.ts), plus
 * exports. Local links open only on this computer, and the panel says so.
 */

type Busy = "create" | "update" | "revoke" | "debug" | "md" | "json" | "html" | null

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } })
  const j = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`)
  return j
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function includedLine(s: ShareInfo): string {
  const st = s.stats
  if (!st) return `${plural(s.messageCount, "message")}${s.redactions ? ` · ${plural(s.redactions, "secret")} redacted` : ""}`
  const bits = [plural(st.messages, "message"), plural(st.toolCalls, "tool step"), plural(st.attachments, "attachment")]
  if (st.reasoning) bits.push(plural(st.reasoning, "thought"))
  if (st.redactions) bits.push(`${plural(st.redactions, "secret")} redacted`)
  return `Includes ${bits.join(" · ")}`
}

function Btn({ onClick, disabled, tone, children }: { onClick(): void; disabled?: boolean; tone?: "err"; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border border-line bg-bg px-2.5 py-1 text-xs transition hover:border-line-2 disabled:opacity-50 ${tone === "err" ? "text-err" : "text-ink-2 hover:text-ink"}`}
    >
      {children}
    </button>
  )
}

export function ShareButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)} className={`rounded-lg px-2 py-1 text-xs transition ${open ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>
        Share
      </button>
      {open && <SharePanel sessionId={sessionId} />}
    </div>
  )
}

function SharePanel({ sessionId }: { sessionId: string }) {
  const { mode } = useWorkspaces()
  const local = mode === "local"
  const directory = useOptionalEngine()?.directory || undefined
  const params = useParams<{ id?: string; sid?: string }>()
  const workspaceId = !local && params?.sid ? params.id : undefined
  const [share, setShare] = useState<ShareInfo | null | undefined>(undefined)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<"link" | "debug" | null>(null)
  const [links, setLinks] = useState(false)

  useEffect(() => {
    let alive = true
    api<{ shares: ShareInfo[] }>(`/api/shares?session=${encodeURIComponent(sessionId)}`)
      .then((j) => alive && setShare(j.shares[0] ?? null))
      .catch((e: Error) => {
        if (!alive) return
        setShare(null)
        setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  function flash(what: "link" | "debug") {
    setCopied(what)
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 2500)
  }

  const create = () =>
    run("create", async () => {
      const j = await api<{ share: ShareInfo }>("/api/shares", { method: "POST", body: JSON.stringify({ sessionId, workspaceId, directory: local ? directory : undefined }) })
      setShare(j.share)
      await copyText(j.share.url).catch(() => {})
      flash("link")
    })
  const update = () =>
    run("update", async () => {
      const j = await api<{ share: ShareInfo }>(`/api/shares/${share!.id}`, { method: "PATCH" })
      setShare(j.share)
    })
  const revoke = () => {
    if (!window.confirm("Stop sharing this chat? The link stops working right away.")) return
    void run("revoke", async () => {
      await api(`/api/shares/${share!.id}`, { method: "DELETE" })
      setShare(null)
    })
  }
  const debug = () =>
    run("debug", async () => {
      const j = await api<{ url: string }>(`/api/shares/${share!.id}/debug`, { method: "POST" })
      await copyText(j.url)
      flash("debug")
    })

  const exportQuery = () => {
    const q = new URLSearchParams({ session: sessionId })
    if (local && directory) q.set("directory", directory)
    if (workspaceId) q.set("workspace", workspaceId)
    return q
  }
  const download = (format: "md" | "json") =>
    run(format, async () => {
      const q = exportQuery()
      q.set("format", format)
      q.set("download", "1")
      const r = await fetch(`/api/shares/export?${q}`, { cache: "no-store" })
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Export failed")
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? `chat.${format}`
      const { saveFile } = await import("./share-export")
      saveFile(name, await r.text(), format === "md" ? "text/markdown" : "application/json")
    })
  const html = () =>
    run("html", async () => {
      const q = exportQuery()
      q.set("format", "bundle")
      const j = await api<{ transcript: Transcript }>(`/api/shares/export?${q}`)
      const { saveFile, transcriptToHtml } = await import("./share-export")
      const name = (j.transcript.title || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat"
      saveFile(`${name}.html`, await transcriptToHtml(j.transcript), "text/html")
    })

  return (
    <div role="dialog" aria-label="Share chat" className="pop absolute top-full right-0 z-30 mt-2 w-[min(440px,92vw)] rounded-xl border border-line bg-surface p-4 text-left shadow-card">
      {share === undefined ? (
        <div className="space-y-2">
          <Skel className="h-4 w-32" />
          <Skel className="h-3.5 w-full" />
          <Skel className="h-3.5 w-3/4" />
        </div>
      ) : share === null ? (
        <>
          <h2 className="font-serif text-[1.05rem] font-medium text-ink">Share this chat</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">Anyone with the link can read this chat as it is right now: every message, tool step and attachment. They can&apos;t reply, and nothing you send later shows up.</p>
          <ul className="mt-2.5 space-y-1 text-[12px] text-muted">
            <li>Keys and tokens are redacted. File paths are shortened.</li>
            <li>Hidden from search engines. Stop sharing any time.</li>
          </ul>
          {local && <LocalNote />}
          <button type="button" onClick={() => void create()} disabled={!!busy} className="mt-3.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink transition hover:opacity-90 disabled:opacity-70">
            {busy === "create" ? <Brew mood="save" tone="inherit" timerAfter={0} /> : "Create link"}
          </button>
        </>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-serif text-[1.05rem] font-medium text-ink">Shared</h2>
            <span className="text-[11px] text-muted">{plural(share.views, "view")}</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input readOnly value={share.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-1.5 font-mono text-[12px] text-ink-2 outline-none focus:border-line-2" />
            <button
              type="button"
              onClick={() => void copyText(share.url).then(() => flash("link"))}
              className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-ink transition hover:opacity-90"
            >
              {copied === "link" ? "Copied" : "Copy"}
            </button>
            <a href={share.url} target="_blank" rel="noreferrer" className="shrink-0 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-line-2 hover:text-ink">
              Open
            </a>
          </div>
          <p className="mt-2.5 text-[12px] text-ink-2">{includedLine(share)}</p>
          {share.stats && share.stats.attachmentsDropped > 0 && <p className="mt-0.5 text-[12px] text-muted">{plural(share.stats.attachmentsDropped, "large attachment")} left out.</p>}
          <p className="mt-0.5 text-[12px] text-muted">Snapshot from {fmtRelative(share.updatedAt)}. New messages stay private until you update the link.</p>
          {local && <LocalNote />}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Btn onClick={() => void update()} disabled={!!busy}>
              {busy === "update" ? <Brew mood="save" tone="inherit" timerAfter={0} /> : "Update link"}
            </Btn>
            <Btn onClick={() => void debug()} disabled={!!busy}>
              {copied === "debug" ? "Debug link copied" : "Copy debug link"}
            </Btn>
            <Btn onClick={revoke} disabled={!!busy} tone="err">
              Stop sharing
            </Btn>
          </div>
          {copied === "debug" && <p className="mt-2 text-[11px] leading-relaxed text-muted">Valid for 24 hours. It adds router events and logs for this chat, so send it only to someone helping you debug.</p>}
        </>
      )}

      {error && <p className="mt-3 text-[12px] text-err">{error}</p>}

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className="text-[12px] text-muted">Export</span>
        <div className="flex gap-1.5">
          <Btn onClick={() => void download("md")} disabled={!!busy}>
            {busy === "md" ? "Saving…" : "Markdown"}
          </Btn>
          <Btn onClick={() => void download("json")} disabled={!!busy}>
            {busy === "json" ? "Saving…" : "JSON"}
          </Btn>
          <Btn onClick={() => void html()} disabled={!!busy}>
            {busy === "html" ? "Saving…" : "HTML"}
          </Btn>
        </div>
      </div>

      <details className="group/links mt-3 border-t border-line pt-3" onToggle={(e) => setLinks(e.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center justify-between text-[12px] text-muted transition hover:text-ink [&::-webkit-details-marker]:hidden">
          All shared links
          <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0 opacity-60 transition group-open/links:rotate-180">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </summary>
        {links && <SharedLinks variant="compact" key={share?.id ?? "none"} />}
      </details>
    </div>
  )
}

function LocalNote() {
  return <p className="mt-2.5 rounded-lg bg-surface-2 px-2.5 py-2 text-[12px] leading-relaxed text-ink-2">syrup runs on this computer, so this link opens only here. To send the chat to someone else, export it below.</p>
}

/** The owner's live links: copy, open, update, stop. Cards in /settings (cloud), a compact list in the Share panel (both modes). */
export function SharedLinks({ variant = "card" }: { variant?: "card" | "compact" }) {
  const [rows, setRows] = useState<ShareInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api<{ shares: ShareInfo[] }>("/api/shares")
      .then((j) => alive && setRows(j.shares))
      .catch((e: Error) => alive && (setRows([]), setError(e.message)))
    return () => {
      alive = false
    }
  }, [])

  async function act(id: string, fn: () => Promise<void>) {
    setBusy(id)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const update = (s: ShareInfo) =>
    act(s.id, async () => {
      const j = await api<{ share: ShareInfo }>(`/api/shares/${s.id}`, { method: "PATCH" })
      setRows((rs) => rs?.map((r) => (r.id === s.id ? { ...j.share, stats: undefined } : r)) ?? null)
    })
  const stop = (s: ShareInfo) => {
    if (!window.confirm(`Stop sharing "${s.title || "Untitled"}"? The link stops working right away.`)) return
    void act(s.id, async () => {
      await api(`/api/shares/${s.id}`, { method: "DELETE" })
      setRows((rs) => rs?.filter((r) => r.id !== s.id) ?? null)
    })
  }
  const copy = async (s: ShareInfo) => {
    await copyText(s.url)
    setCopied(s.id)
    setTimeout(() => setCopied((c) => (c === s.id ? null : c)), 2000)
  }

  const compact = variant === "compact"
  const list =
    rows === null ? (
      <div className="space-y-2 py-2">
        <Skel className="h-3.5 w-3/4" />
        <Skel className="h-3.5 w-1/2" />
      </div>
    ) : rows.length === 0 ? (
      <p className={`py-2 text-[12px] text-muted ${compact ? "" : "mt-2"}`}>No shared links yet. Use Share in a chat&apos;s header to make one.</p>
    ) : (
      <ul className={`divide-y divide-line ${compact ? "mt-2 max-h-[240px] overflow-y-auto" : "mt-3"}`}>
        {rows.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <a href={s.url} target="_blank" rel="noreferrer" className="block truncate text-[13px] text-ink transition hover:text-accent">
                {s.title || "Untitled"}
              </a>
              <div className="truncate text-[11px] text-muted">
                {plural(s.messageCount, "message")} · {plural(s.views, "view")} · updated {fmtRelative(s.updatedAt)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={() => void copy(s)} className="rounded px-1.5 py-0.5 text-[11px] text-ink-2 transition hover:bg-surface-2 hover:text-ink">
                {copied === s.id ? "Copied" : "Copy"}
              </button>
              <button type="button" onClick={() => void update(s)} disabled={busy === s.id} className="rounded px-1.5 py-0.5 text-[11px] text-ink-2 transition hover:bg-surface-2 hover:text-ink disabled:opacity-50">
                {busy === s.id ? "…" : "Update"}
              </button>
              <button type="button" onClick={() => stop(s)} disabled={busy === s.id} className="rounded px-1.5 py-0.5 text-[11px] text-err transition hover:bg-surface-2 disabled:opacity-50">
                Stop
              </button>
            </div>
          </li>
        ))}
      </ul>
    )

  if (compact)
    return (
      <div>
        {list}
        {error && <p className="mt-1 text-[12px] text-err">{error}</p>}
      </div>
    )
  return (
    <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
      <h2 className="text-sm font-medium text-ink">Shared links</h2>
      <p className="mt-1 text-[13px] text-ink-2">Chats you&apos;ve shared. Anyone with a link can read that snapshot; search engines are told not to index them. Stopping a link takes it down right away.</p>
      {list}
      {error && <p className="mt-2 text-[12px] text-err">{error}</p>}
    </section>
  )
}
