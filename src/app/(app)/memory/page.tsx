"use client"

import { useCallback, useEffect, useState } from "react"
import { Button, Icon } from "@/components/ui/s"
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
      <div className="mx-auto w-full max-w-[880px] px-4 py-8 medium:px-6">
        <div className="flex items-start justify-between gap-4 medium:items-end">
          <div className="min-w-0">
            <h1 className="font-display text-heading text-ink">Memory</h1>
            <p className="mt-2 max-w-[600px] text-base text-ink-2">
              What the agent remembers across sessions. It saves and searches these itself; you can add, correct or delete anything here.
            </p>
          </div>
          {/* The page's one red action (brand); while the editor is open it is the plain Cancel. */}
          <Button variant={adding ? "secondary" : "brand"} icon={adding ? undefined : "plus"} onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "Add memory"}
          </Button>
        </div>

        {adding && (
          <Editor
            onDone={async () => {
              setAdding(false)
              await load(q)
            }}
          />
        )}

        <div className="s-field mt-6">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories" aria-label="Search memories" className="s-field__input" />
        </div>

        {!rows && <MemorySkeleton />}
        {rows && rows.length === 0 && (
          <p className="s-empty-line mt-6 px-2 py-8 text-center">
            {q ? "Nothing matches. Try another word." : "Nothing saved yet. The agent will start remembering as you work, or add something yourself."}
          </p>
        )}

        <ul className="mt-4 flex flex-col gap-3">
          {rows?.map((m) => (
            <MemoryCard key={m.id} m={m} onChange={() => load(q)} />
          ))}
        </ul>
      </div>
    </div>
  )
}

/** One memory as a P2 card on the canvas (s-card--compact: hairline, r20, p20). Kind and tags are neutral badges. */
function MemoryCard({ m, onChange }: { m: Memory; onChange(): Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  if (editing) return <Editor initial={m} onDone={async () => (setEditing(false), await onChange())} onCancel={() => setEditing(false)} />
  const long = m.content.length > 260
  return (
    <li className="s-card s-card--compact">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base text-ink">{m.title}</span>
        <span className="s-badge">{m.kind}</span>
        {m.tags &&
          m.tags.split(",").map((t) => (
            <span key={t} className="s-badge">
              {t}
            </span>
          ))}
      </div>
      <p className={`text-sm whitespace-pre-wrap text-ink-2 ${open || !long ? "" : "line-clamp-3"}`}>{m.content}</p>
      {/* On touch the text buttons get 44px hit areas; the negative margin keeps the row as tight as before. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="s-meta">{m.source === "agent" ? "Saved by agent" : "Added by you"}</span>
        <span className="s-meta">{fmtRelative(m.updatedAt)}</span>
        {long && (
          <Button variant="link-neutral" size="sm" onClick={() => setOpen((v) => !v)} className="pointer-coarse:-my-2.5 pointer-coarse:min-h-11">
            {open ? "Less" : "More"}
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="link-neutral" size="sm" onClick={() => setEditing(true)} className="pointer-coarse:-my-2.5 pointer-coarse:min-h-11">
          Edit
        </Button>
        <Button
          variant="link-neutral"
          size="sm"
          onClick={async () => {
            await fetch(`/api/memory/${m.id}`, { method: "DELETE" })
            await onChange()
          }}
          className="pointer-coarse:-my-2.5 pointer-coarse:min-h-11"
        >
          Forget
        </Button>
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
    <div className="s-card s-card--compact mt-4">
      {/* Phones: every field on its own line, and Cancel/Save in a bar pinned to the bottom of the screen while the editor is in view. */}
      <div className="flex flex-col gap-3 medium:flex-row">
        <div className="s-field min-w-0 flex-1">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" className="s-field__input" />
        </div>
        <div className="s-field s-field--select medium:w-48">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <Icon name="chevron-down" />
        </div>
      </div>
      {/* Always several lines tall, so it takes the grown (r20) multi-line shape from the start. */}
      <div className="s-field s-field--multi" data-grown="">
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="The fact, and why it matters." aria-label="Memory" rows={4} className="s-field__input" />
      </div>
      <div className="flex flex-col gap-3 medium:flex-row medium:flex-wrap medium:items-center">
        <div className="s-field min-w-0 medium:flex-1">
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, comma separated" aria-label="Tags" className="s-field__input" />
        </div>
        {err && <p className="s-field-error medium:order-last medium:basis-full">{err}</p>}
        <div className="sticky bottom-0 z-sticky -mx-5 -mb-5 flex gap-2 border-t border-line bg-bg px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] medium:static medium:m-0 medium:border-0 medium:bg-transparent medium:p-0">
          {onCancel && (
            <Button variant="secondary" onClick={onCancel} className="flex-1 medium:flex-none">
              Cancel
            </Button>
          )}
          <Button busy={busy} disabled={!title.trim() || !content.trim()} onClick={() => void save()} className="flex-1 medium:flex-none">
            {initial ? "Save" : "Add"}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Three cards at the height of a short memory, so the list does not jump in. */
function MemorySkeleton() {
  return (
    <ul aria-busy className="skel-in mt-4 flex flex-col gap-3">
      {["w-40", "w-56", "w-32"].map((w) => (
        <li key={w} className="s-card s-card--compact">
          <span className={`s-skeleton s-skeleton--row ${w}`} />
          <div className="s-skeleton-stack">
            <span className="s-skeleton s-skeleton--line" />
            <span className="s-skeleton s-skeleton--line" />
          </div>
          <span className="s-skeleton s-skeleton--line w-36" />
        </li>
      ))}
    </ul>
  )
}
