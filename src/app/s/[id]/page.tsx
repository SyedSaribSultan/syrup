"use client"

import { useParams } from "next/navigation"
import { useEffect, useMemo, useRef } from "react"
import { Changes } from "@/components/changes"
import { Composer } from "@/components/composer"
import { MessageView } from "@/components/message"
import { Prompts } from "@/components/prompts"
import { useEngine } from "@/lib/engine-store"
import { fmtCost, fmtTokens } from "@/lib/format"

export default function SessionPage() {
  const { id } = useParams<{ id: string }>()
  const { sessions, messages, status, errors, loadMessages, send, abort } = useEngine()
  const session = sessions[id]
  const sm = messages[id]
  const busy = status[id]?.type === "busy" || status[id]?.type === "retry"
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    void loadMessages(id)
  }, [id, loadMessages])

  const entries = useMemo(() => (sm ? sm.order.map((mid) => sm.byId[mid]).filter(Boolean) : []), [sm])
  const lastID = entries[entries.length - 1]?.info.id

  // Follow the stream unless the user has scrolled up.
  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [entries])

  function onScroll() {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // Session totals, summed from the assistant messages we have loaded.
  const totals = useMemo(() => {
    let tokens = 0
    let cost = 0
    for (const e of entries) {
      if (e.info.role !== "assistant") continue
      const t = e.info.tokens
      if (t) tokens += t.input + t.output + t.reasoning
      cost += e.info.cost ?? 0
    }
    return { tokens, cost }
  }, [entries])

  return (
    <>
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line px-5">
        <h1 className="min-w-0 truncate text-sm font-medium text-ink">{session?.title || "New chat"}</h1>
        <div className="flex shrink-0 items-center gap-3">
          {(totals.tokens > 0 || totals.cost > 0) && (
            <div className="text-xs text-muted">
              {fmtTokens(totals.tokens)} tokens · {fmtCost(totals.cost)}
            </div>
          )}
          <Changes sessionID={id} />
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] space-y-6 px-6 pt-6 pb-40">
          {!sm?.loaded && <div className="text-sm text-muted">Loading…</div>}
          {entries.map((e) => (
            <MessageView key={e.info.id} entry={e} streaming={busy && e.info.id === lastID && e.info.role === "assistant"} />
          ))}
          <Prompts sessionID={id} />
          {status[id]?.type === "retry" && (
            <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[13px] text-ink-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn pulse" />
              <span>
                Provider is busy, retrying (attempt {status[id].attempt}){status[id].message ? ` — ${status[id].message}` : ""}
              </span>
            </div>
          )}
          {errors[id] && <div className="rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-[13px] text-err">{errors[id]}</div>}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg via-bg/90 to-transparent pt-10 pb-5">
        <div className="pointer-events-auto mx-auto w-full max-w-[720px] px-6">
          <Composer onSend={(t, files) => send(id, t, files)} onStop={() => void abort(id)} busy={busy} autoFocus />
        </div>
      </div>
    </>
  )
}
