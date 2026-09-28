"use client"

import { useEffect, useMemo, useRef } from "react"
import { Brew, Skel } from "@/components/brew"
import { Changes } from "@/components/changes"
import { Composer } from "@/components/composer"
import { useLogs } from "@/components/logs-modal"
import { MessageView } from "@/components/message"
import { Prompts } from "@/components/prompts"
import { ShareButton } from "@/components/share-dialog"
import { PanelToggle } from "@/components/side-panel"
import { useEngine } from "@/lib/engine-store"
import { fmtCost, fmtTokens } from "@/lib/format"
import { useFeedback } from "@/lib/use-feedback"

/** One chat session: header, message list, prompts, composer. Works against whatever engine the EngineProvider is connected to. */
export function SessionView({ id }: { id: string }) {
  const { sessions, messages, status, errors, loadMessages, send, abort } = useEngine()
  const session = sessions[id]
  const sm = messages[id]
  const busy = status[id]?.type === "busy" || status[id]?.type === "retry"
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const { open: openLogs } = useLogs()

  useEffect(() => {
    void loadMessages(id)
  }, [id, loadMessages])

  const entries = useMemo(() => (sm ? sm.order.map((mid) => sm.byId[mid]).filter(Boolean) : []), [sm])
  const { ratings, rate } = useFeedback(id)
  // Thumbs go on the last reply of each turn: an assistant message followed by the user's next message, or by nothing.
  const turnEnds = useMemo(() => new Set(entries.filter((e, i) => e.info.role === "assistant" && entries[i + 1]?.info.role !== "assistant").map((e) => e.info.id)), [entries])
  const lastID = entries[entries.length - 1]?.info.id
  const lastRole = entries[entries.length - 1]?.info.role
  // Sent, but the engine has not opened the answer yet.
  const awaiting = busy && lastRole === "user"

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
          <ShareButton sessionId={id} />
          <button type="button" onClick={openLogs} className="rounded-lg px-2 py-1 text-xs text-ink-2 transition hover:bg-surface-2 hover:text-ink">
            Logs
          </button>
          <PanelToggle />
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] space-y-6 px-6 pt-6 pb-40">
          {!sm?.loaded && entries.length === 0 && <ChatSkeleton />}
          {entries.map((e) => (
            <MessageView
              key={e.info.id}
              entry={e}
              streaming={busy && e.info.id === lastID && e.info.role === "assistant"}
              rating={ratings[e.info.id] ?? null}
              onRate={turnEnds.has(e.info.id) ? (r, model) => rate(e.info.id, r, model) : undefined}
            />
          ))}
          {awaiting && (
            <div className="py-2">
              <Brew mood="think" size="md" />
            </div>
          )}
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

/** Shaped like a short exchange, so the page does not jump when the real messages arrive. */
function ChatSkeleton() {
  return (
    <div aria-busy className="skel-in space-y-6">
      <div className="flex justify-end">
        <Skel className="h-11 w-[44%] rounded-2xl rounded-br-md" />
      </div>
      <div className="space-y-2.5 pt-1">
        <Skel className="h-3.5 w-[92%]" />
        <Skel className="h-3.5 w-[86%]" />
        <Skel className="h-3.5 w-[58%]" />
      </div>
      <div className="flex justify-end">
        <Skel className="h-11 w-[30%] rounded-2xl rounded-br-md" />
      </div>
      <div className="space-y-2.5 pt-1">
        <Skel className="h-9 w-full rounded-xl" />
        <Skel className="h-3.5 w-[78%]" />
        <Skel className="h-3.5 w-[40%]" />
      </div>
    </div>
  )
}
