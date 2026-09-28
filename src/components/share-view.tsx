"use client"

import Link from "next/link"
import { useEffect, useMemo } from "react"
import type { MessageEntry } from "@/lib/engine-store"
import type { Message, Part } from "@/lib/oc"
import type { TMessage, TPart, Transcript } from "@/lib/transcript"
import { MessageView } from "./message"
import { ReadOnlyProvider } from "./read-only"

/**
 * A shared chat, rendered with the app's own message components in read-only
 * mode. Used by the public viewer (/c/[id]) and the self-contained HTML export,
 * so both look exactly like the chat did in syrup.
 */

const SESSION = "shared"

function partOf(p: TPart, m: TMessage): Part | null {
  const base = { id: p.id, sessionID: SESSION, messageID: m.id }
  switch (p.type) {
    case "text":
      return { ...base, type: "text", text: p.text, synthetic: p.synthetic, time: p.time?.start !== undefined ? { start: p.time.start, end: p.time.end } : undefined }
    case "reasoning":
      return { ...base, type: "reasoning", text: p.text, time: { start: p.time?.start ?? 0, end: p.time?.end ?? p.time?.start ?? 1 } }
    case "tool": {
      const time = { start: p.time?.start ?? 0, end: p.time?.end ?? p.time?.start ?? 0 }
      const input = (p.input && typeof p.input === "object" ? p.input : { value: p.input }) as Record<string, unknown>
      const state =
        p.status === "completed"
          ? { status: "completed" as const, input, output: p.output ?? "", title: p.title ?? "", metadata: {}, time }
          : p.status === "error"
            ? { status: "error" as const, input, error: p.error ?? "", time }
            : { status: "running" as const, input, title: p.title, time: { start: time.start } }
      return { ...base, type: "tool", callID: p.callId ?? p.id, tool: p.tool, state }
    }
    case "file":
      return { ...base, type: "file", mime: p.mime, filename: p.filename ?? p.path, url: p.url ?? "" }
    case "patch":
      return { ...base, type: "patch", hash: "", files: p.files }
    case "compaction":
      return { ...base, type: "compaction", auto: !!p.auto }
    default:
      return null
  }
}

/** The snapshot in the engine's message shape, so MessageView renders it unchanged. */
export function toEntries(t: Transcript): MessageEntry[] {
  return t.messages.map((m) => {
    const parts = m.parts.map((p) => partOf(p, m)).filter((p): p is Part => p !== null)
    if (m.role === "user") {
      const info = { id: m.id, sessionID: SESSION, role: "user", time: { created: m.createdAt }, agent: m.agent ?? "build", model: { providerID: m.provider ?? "", modelID: m.model ?? "" } }
      return { info: info as unknown as Message, parts }
    }
    const tk = m.tokens ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const info = {
      id: m.id,
      sessionID: SESSION,
      role: "assistant",
      time: { created: m.createdAt, completed: m.completedAt ?? m.createdAt },
      providerID: m.provider ?? "",
      modelID: m.model ?? "",
      mode: m.agent ?? "build",
      parentID: "",
      path: { cwd: "", root: "" },
      cost: m.cost ?? 0,
      tokens: { input: tk.input, output: tk.output, reasoning: tk.reasoning, cache: { read: tk.cacheRead, write: tk.cacheWrite } },
      ...(m.error ? { error: { name: "UnknownError", data: { message: m.error } } } : {}),
    }
    return { info: info as unknown as Message, parts }
  })
}

const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })

export function shareDate(ms: number): string {
  return DATE.format(new Date(ms))
}

/** Markdown / JSON links: small text, 44px tall on touch screens. */
const FORMAT_LINK = "rounded px-1 py-0.5 transition hover:text-ink pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center pointer-coarse:px-2"

/**
 * Header, messages and footer of a shared chat. `id` adds the Markdown/JSON links; `homeHref` the "Try syrup" link.
 * The wordmark row stays pinned while reading (under the notch on phones); the title block scrolls away.
 */
export function ShareDocument({ transcript: t, id, homeHref }: { transcript: Transcript; id?: string; homeHref?: string }) {
  const entries = useMemo(() => toEntries(t), [t])
  const n = t.stats.messages
  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 bg-surface pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-12 w-full max-w-[720px] items-center justify-between gap-3 px-4 medium:h-16 medium:px-6 medium:pt-2">
          {homeHref ? (
            <Link href={homeHref} prefetch={false} className="font-serif text-[1.2rem] font-semibold tracking-tight text-ink medium:text-[1.35rem]">
              syrup
            </Link>
          ) : (
            <span className="font-serif text-[1.2rem] font-semibold tracking-tight text-ink medium:text-[1.35rem]">syrup</span>
          )}
          {id && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <a href={`/c/${id}/md`} className={FORMAT_LINK}>
                Markdown
              </a>
              <span aria-hidden>·</span>
              <a href={`/c/${id}/json`} className={FORMAT_LINK}>
                JSON
              </a>
            </div>
          )}
        </div>
      </div>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto w-full max-w-[720px] px-4 pt-3 pb-5 medium:px-6 medium:pt-4 medium:pb-7">
          <h1 className="font-serif text-[1.5rem] leading-tight font-medium tracking-tight break-words text-ink medium:text-[1.9rem]">{t.title}</h1>
          <p className="mt-2 text-[13px] text-muted">
            Shared from syrup · {shareDate(t.snapshotAt)} · {n} message{n === 1 ? "" : "s"}
          </p>
          {t.models.length > 0 && <p className="mt-0.5 text-[13px] text-muted">{t.models.join(", ")}</p>}
        </div>
      </header>

      {/* Long words wrap; code and tables scroll inside themselves (Markdown wraps them), never the page. */}
      <main className="chat-log mx-auto w-full max-w-[720px] min-w-0 px-4 pt-6 pb-12 medium:px-6 medium:pt-8">
        <ReadOnlyProvider answers={t.answers}>
          <div className="space-y-6">
            {entries.map((e) => (
              <MessageView key={e.info.id} entry={e} streaming={false} />
            ))}
          </div>
        </ReadOnlyProvider>
        {t.notes.length > 0 && (
          <div className="mt-8 space-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-[12px] text-muted">
            {t.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] medium:flex-row medium:items-center medium:justify-between medium:px-6">
          <p className="max-w-[440px] text-[12px] leading-relaxed text-muted">
            A snapshot from {shareDate(t.snapshotAt)}. Anything said after it stays private. Secrets are redacted and file paths are shortened.
          </p>
          {homeHref && (
            <Link href={homeHref} prefetch={false} className="shrink-0 self-start rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-accent-ink transition hover:opacity-90 pointer-coarse:py-3.5 medium:self-auto">
              Try syrup
            </Link>
          )}
        </div>
      </footer>
    </div>
  )
}

/** Counts one view per browser per day. One request after load; no timers. */
export function ViewBeacon({ id }: { id: string }) {
  useEffect(() => {
    try {
      const key = `syrup.viewed.${id}`
      const today = new Date().toISOString().slice(0, 10)
      if (localStorage.getItem(key) === today) return
      localStorage.setItem(key, today)
    } catch {}
    void fetch(`/c/${id}/view`, { method: "POST", keepalive: true }).catch(() => {})
  }, [id])
  return null
}
