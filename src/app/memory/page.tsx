"use client"

import { useCallback, useEffect, useState } from "react"
import { fmtRelative } from "@/lib/format"

type Memory = {
  id: string
  kind: string
  title: string
  content: string
  tags: string
  source: string
  sessionId: string | null
  createdAt: number
  updatedAt: number
}

const KINDS = ["fact", "preference", "project", "reference", "note"]

export default function MemoryPage() {
  const [rows, setRows] = useState<Memory[] | null>(null)
  const [q, setQ] = useState("")
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (query: string) => {
    const r = await fetch(`/api/memory?q=${encodeURIComponent(query)}&limit=200`, { cache: "no-store" })
    const j = await r.json()
    setRows(j.memories)
  }, [])

  // Debounced search; state is set from the response callback.
  useEffect(() => {
    const t = setTimeout(() => void load(q), q ? 200 : 0)
    return () => clearTimeout(t)
  }, [q, load])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-6 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink">Memory</h1>
            <p className="mt-1 max-w-[600px] text-sm text-muted">
              What the agent remembers across sessions. It saves and searches these itself; you can add, correct or delete anything here.
            </p>
          </div>
          <button type="button" onClick={() => setAdding((v) => !v)} className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink">
            {adding ? "Cancel" : "+ Add memory"}
          </button>
        </div>

        {adding && (
          <Editor
            onDone={async () => {
              setAdding(false)
              await load(q)
            }}
          />
        )}

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search memories…"
          className="mt-6 w-full rounded-xl border border-line bg-surface px-4 py-2.5 text-sm outline-none placeholder:text-muted focus:border-line-2"
        />

        {!rows && <div className="mt-6 text-sm text-muted">Loading…</div>}
        {rows && rows.length === 0 && (
          <div className="mt-6 rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
            {q ? "Nothing matches." : "Nothing saved yet. The agent will start remembering as you work, or add something yourself."}
          </div>
        )}

        <ul className="mt-4 space-y-2">
          {rows?.map((m) => (
            <MemoryCard key={m.id} m={m} onChange={() => load(q)} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function MemoryCard({ m, onChange }: { m: Memory; onChange(): Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  if (editing) return <Editor initial={m} onDone={async () => (setEditing(false), await onChange())} onCancel={() => setEditing(false)} />
  const long = m.content.length > 260
  return (
    <li className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-medium text-ink">{m.title}</span>
            <span className="rounded bg-surface-2 px-1.5 text-[10px] font-medium text-ink-2">{m.kind}</span>
            {m.tags &&
              m.tags.split(",").map((t) => (
                <span key={t} className="rounded bg-accent-soft px-1.5 text-[10px] font-medium text-accent">
                  {t}
                </span>
              ))}
          </div>
          <p className={`mt-1.5 text-[13px] leading-relaxed text-ink-2 whitespace-pre-wrap ${open || !long ? "" : "line-clamp-3"}`}>{m.content}</p>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted">
            <span>{m.source === "agent" ? "saved by agent" : "added by you"}</span>
            <span>{fmtRelative(m.updatedAt)}</span>
            {long && (
              <button type="button" onClick={() => setOpen((v) => !v)} className="text-ink-2 hover:text-ink">
                {open ? "less" : "more"}
              </button>
            )}
            <span className="flex-1" />
            <button type="button" onClick={() => setEditing(true)} className="text-ink-2 hover:text-ink">
              Edit
            </button>
            <button
              type="button"
              onClick={async () => {
                await fetch(`/api/memory/${m.id}`, { method: "DELETE" })
                await onChange()
              }}
              className="text-muted hover:text-err"
            >
              Forget
            </button>
          </div>
        </div>
      </div>
    </li>
  )
}

function Editor({ initial, onDone, onCancel }: { initial?: Memory; onDone(): Promise<void>; onCancel?(): void }) {
  const [title, setTitle] = useState(initial?.title ?? "")
  const [content, setContent] = useState(initial?.content ?? "")
  const [kind, setKind] = useState(initial?.kind ?? "note")
  const [tags, setTags] = useState(initial?.tags ?? "")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch(initial ? `/api/memory/${initial.id}` : "/api/memory", {
        method: initial ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, content, kind, tags }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed")
      await onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-line-2 bg-surface p-4 shadow-card">
      <div className="flex gap-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-line-2" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg border border-line bg-bg px-2 py-1.5 text-sm outline-none">
          {KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="The fact, and why it matters."
        rows={4}
        className="mt-2 w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-sm leading-relaxed outline-none focus:border-line-2"
      />
      <div className="mt-2 flex items-center gap-2">
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma, separated" className="flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-line-2" />
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2">
            Cancel
          </button>
        )}
        <button type="button" onClick={() => void save()} disabled={busy || !title.trim() || !content.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40">
          {busy ? "Saving…" : initial ? "Save" : "Add"}
        </button>
      </div>
      {err && <div className="mt-2 text-xs text-err">{err}</div>}
    </div>
  )
}
