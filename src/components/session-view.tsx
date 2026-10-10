"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Brew, Skel } from "@/components/brew"
import { ChangesButton } from "@/components/changes"
import { RouterProgress } from "@/components/router-progress"
import { Composer } from "@/components/composer"
import { useLogs } from "@/components/logs-modal"
import { MessageView } from "@/components/message"
import { preloadLiveText } from "@/components/parts"
import { Prompts } from "@/components/prompts"
import { ShareButton } from "@/components/share-dialog"
import { PanelToggle } from "@/components/side-panel"
import { useEngine } from "@/lib/engine-store"
import { fmtCost, fmtTokens } from "@/lib/format"
import { usePanel } from "@/lib/panel"
import { useDismiss } from "@/lib/use-dismiss"
import { useFeedback } from "@/lib/use-feedback"
import { useNarrow } from "@/lib/use-window-class"
import { useWorkspaces } from "@/lib/workspaces"
import { MenuButton } from "./app-shell"
import { ModelPicker } from "./model-picker"
import { alertDialog, confirmDialog, promptDialog } from "./ui/dialog"
import { MenuList, Popover, type MenuItem } from "./ui/sheet"

/**
 * After a turn ends (and when a chat opens), the chat keeps following until what it shows has settled: no text still
 * typing out ([data-revealing]), nothing still loading ([aria-busy], a rich block drawing), and the log's height
 * unchanged for this long. Measured, not a fixed window: a slow phone takes as long as it takes.
 */
const FOLLOW_STABLE_MS = 500
/** Content that is still changing size: text typing out, a block or chunk loading. */
const SETTLING = "[data-revealing], [aria-busy='true'], figure.rich[data-rich-state='loading']"
/** A safety stop: something stuck loading never keeps the chat pinned for good. */
const FOLLOW_MAX_MS = 30_000

/** One chat session: header, message list, prompts, composer. Works against whatever engine the EngineProvider is connected to. */
export function SessionView({ id }: { id: string }) {
  const { sessions, messages, status, errors, live, loadMessages, send, abort } = useEngine()
  // Beside the side pane the chat can be as narrow as 440 px: the title keeps the room (the totals are in ⋯ → Chat info).
  const paneOpen = !!usePanel()?.open
  const session = sessions[id]
  const sm = messages[id]
  const busy = status[id]?.type === "busy" || status[id]?.type === "retry"
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [scrolledUp, setScrolledUp] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const narrow = useNarrow()
  const w = useWorkspaces()

  useEffect(() => {
    void loadMessages(id)
  }, [id, loadMessages])
  // The streaming-text code loads on first use; fetch it now, so the first reply never waits for it.
  useEffect(() => preloadLiveText(), [])

  const entries = useMemo(() => (sm ? sm.order.map((mid) => sm.byId[mid]).filter(Boolean) : []), [sm])
  const { ratings, rate } = useFeedback(id)
  // Thumbs go on the last reply of each turn: an assistant message followed by the user's next message, or by nothing.
  const turnEnds = useMemo(() => new Set(entries.filter((e, i) => e.info.role === "assistant" && entries[i + 1]?.info.role !== "assistant").map((e) => e.info.id)), [entries])
  const lastID = entries[entries.length - 1]?.info.id
  // While the chat is busy, replies after its last user message belong to the running turn: their numbers wait for its end.
  // (No user message yet while busy: everything is the running turn, so nothing is checked.)
  const lastUser = entries.findLastIndex((e) => e.info.role === "user")
  const runningFrom = !busy ? entries.length : Math.max(lastUser, 0)
  const fixNumbers = useCallback((prompt: string) => void send(id, prompt), [send, id])
  const lastRole = entries[entries.length - 1]?.info.role
  // Sent, but the engine has not opened the answer yet.
  const awaiting = busy && lastRole === "user"

  // Follow the stream unless the user has scrolled up: on new entries, and whenever the log grows while the agent works.
  // When the turn ends (or the chat opens), keep following until the chat has settled: the typewriter is still a
  // fraction of a second behind when the engine ends the turn, the thumbs and the model line arrive after it, and a
  // diagram draws after its chunk loads. A rich block that starts drawing later re-arms it. Idle, growth the user
  // caused (a row opened at the end) stays put: acting in the chat ends the follow.
  const following = useRef(busy)
  const settle = useRef<() => void>(() => {})
  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
    settle.current()
  }, [entries])
  useEffect(() => {
    following.current = busy
    if (!busy) settle.current()
  }, [busy])
  useEffect(() => {
    const el = scroller.current
    const log = el?.firstElementChild
    if (!el || !log || typeof ResizeObserver === "undefined") return
    /** The post-turn follow: on while the log still settles, off once it has been still for FOLLOW_STABLE_MS. */
    let timer: ReturnType<typeof setTimeout> | undefined
    let settling = false
    let touched = false
    const stop = () => {
      clearTimeout(timer)
      timer = undefined
      settling = false
    }
    settle.current = () => {
      touched = false
      if (settling) return
      settling = true
      const start = performance.now()
      let height = -1
      let stillSince = start
      const tick = () => {
        if (!settling) return
        const now = performance.now()
        if (el.scrollHeight !== height) {
          height = el.scrollHeight
          stillSince = now
          if (stickToBottom.current) el.scrollTop = height
        }
        if (log.querySelector(SETTLING)) stillSince = now
        if ((!following.current && now - stillSince >= FOLLOW_STABLE_MS) || now - start > FOLLOW_MAX_MS) return stop()
        timer = setTimeout(tick, 100)
      }
      tick()
    }
    let frame = 0
    const ro = new ResizeObserver(() => {
      if (!stickToBottom.current) return
      // While the agent writes, follow in this callback (before paint, so the text never jumps a frame behind).
      if (following.current) {
        el.scrollTop = el.scrollHeight
        return
      }
      // Otherwise on the next frame: reading layout inside the callback while fonts and pictures still arrive makes
      // WebKit report a ResizeObserver loop. Growth while something still settles (a block drawing after the turn)
      // re-arms the follow.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!stickToBottom.current) return
        if (!settling && !touched && log.querySelector(SETTLING)) settle.current()
        if (settling) el.scrollTop = el.scrollHeight
      })
    })
    ro.observe(log)
    // The user acting in the chat (opening a row, selecting text) ends the follow: what they opened stays where it is.
    const mine = () => {
      if (following.current) return
      touched = true
      stop()
    }
    el.addEventListener("pointerdown", mine)
    el.addEventListener("keydown", mine)
    settle.current()
    return () => {
      stop()
      cancelAnimationFrame(frame)
      settle.current = () => {}
      ro.disconnect()
      el.removeEventListener("pointerdown", mine)
      el.removeEventListener("keydown", mine)
    }
  }, [])

  // Only the reader moving up lets go of the bottom. Being far from it is not enough: a burst of text can grow the log
  // by more than the margin between the chat's own scroll and its scroll event, which used to strand the chat mid-reply.
  // And only the reader: the browser moves the scroll position up by itself when the log gets shorter, and when content
  // above the view changes size (scroll anchoring: a code block that becomes a smaller diagram, a skeleton replaced by
  // its picture). So moving up lets go only within a second of the reader's own wheel, touch, key or pointer.
  const lastTop = useRef(0)
  const intentAt = useRef(-Infinity)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const mark = () => {
      intentAt.current = performance.now()
    }
    const kinds = ["wheel", "touchmove", "keydown", "pointerdown"] as const
    for (const k of kinds) el.addEventListener(k, mark, { passive: true })
    return () => {
      for (const k of kinds) el.removeEventListener(k, mark)
    }
  }, [])
  function onScroll() {
    const el = scroller.current
    if (!el) return
    const top = el.scrollTop
    if (el.scrollHeight - top - el.clientHeight < 80) stickToBottom.current = true
    else if (top < lastTop.current - 1 && performance.now() - intentAt.current < 1000) stickToBottom.current = false
    lastTop.current = top
    setScrolledUp(!stickToBottom.current)
  }

  function toBottom() {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = true
    setScrolledUp(false)
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
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
      {/* Phones and tablets: ☰ · model · new chat · panel · ⋯ (the model lives here, not in the composer). Desktop: title · Changes · Share · Files · ⋯. */}
      <header className="shrink-0 border-b border-line pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-1 px-2 pointer-coarse:h-14 expanded:gap-3 expanded:px-5">
          <MenuButton />
          <div className="flex min-w-0 flex-1 items-center expanded:hidden">
            <ModelPicker variant="bar" />
          </div>
          <h1 className="hidden min-w-0 flex-1 truncate text-sm font-medium text-ink expanded:block">{session?.title || "New chat"}</h1>
          <div className="flex shrink-0 items-center gap-0.5 expanded:gap-3">
            {(totals.tokens > 0 || totals.cost > 0) && !paneOpen && (
              <div className="hidden text-xs text-muted large:block">
                {fmtTokens(totals.tokens)} tokens · {fmtCost(totals.cost)}
              </div>
            )}
            <div className="hidden expanded:block">
              <ChangesButton sessionID={id} />
            </div>
            <ShareButton sessionId={id} open={shareOpen} onOpenChange={setShareOpen} trigger={!narrow} />
            {w.newChatHref && (
              <Link href={w.newChatHref} aria-label="New chat" title="New chat" className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11 expanded:hidden">
                <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2.5H4A1.5 1.5 0 0 0 2.5 4v9A1.5 1.5 0 0 0 4 14.5h9a1.5 1.5 0 0 0 1.5-1.5V9M12.3 2.2l2.5 2.5L8.5 11H6V8.5l6.3-6.3Z" />
                </svg>
              </Link>
            )}
            <PanelToggle compact className="expanded:hidden" />
            <div className="hidden expanded:block">
              <PanelToggle />
            </div>
            <ChatMenu id={id} title={session?.title || "New chat"} totals={totals} onShare={() => setShareOpen(true)} />
          </div>
        </div>
      </header>

      {/* overflow-x-hidden: a guard, so nothing that still overflows can make the chat pan sideways on a phone. */}
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="chat-log mx-auto w-full max-w-[720px] space-y-6 px-4 pt-5 pb-40 medium:px-6 medium:pt-6">
          {!sm?.loaded && entries.length === 0 && <ChatSkeleton />}
          {entries.map((e, i) => (
            <MessageView
              key={e.info.id}
              entry={e}
              streaming={busy && e.info.id === lastID && e.info.role === "assistant"}
              live={live}
              rating={ratings[e.info.id] ?? null}
              onRate={turnEnds.has(e.info.id) ? (r, model) => rate(e.info.id, r, model) : undefined}
              checkNumbers={e.info.role === "assistant" && i < runningFrom}
              onFix={!busy && e.info.id === lastID && e.info.role === "assistant" ? fixNumbers : undefined}
            />
          ))}
          {awaiting && (
            <div className="py-2">
              <Brew mood="think" size="md" />
              <RouterProgress sessionID={id} since={entries[entries.length - 1]?.info.time.created ?? 0} active />
            </div>
          )}
          {!narrow && <Prompts sessionID={id} />}
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

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg via-bg/90 to-transparent pt-10 pb-[max(0.75rem,env(safe-area-inset-bottom))] medium:pb-5">
        <div className="mx-auto w-full max-w-[720px] px-3 medium:px-6">
          {scrolledUp && (
            <button
              type="button"
              onClick={toBottom}
              aria-label="Scroll to the latest message"
              className="pointer-events-auto mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-card transition hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 2.5v9M3 7.5l4 4 4-4" />
              </svg>
            </button>
          )}
          {/* On phones a permission or question waits right above the composer, where it can't scroll out of sight. */}
          {narrow && (
            <div className="chat-log pointer-events-auto mb-2 max-h-[45dvh] overflow-y-auto overscroll-contain rounded-xl bg-bg shadow-card empty:hidden">
              <Prompts sessionID={id} />
            </div>
          )}
          <div className="pointer-events-auto">
            <Composer onSend={(t, files) => send(id, t, files)} onStop={() => void abort(id)} busy={busy} autoFocus />
          </div>
        </div>
      </div>
    </>
  )
}

/** ⋯ in the chat header: rename, share, logs, token and cost totals, delete. A sheet on phones. */
function ChatMenu({ id, title, totals, onShare }: { id: string; title: string; totals: { tokens: number; cost: number }; onShare(): void }) {
  const { renameSession, deleteSession } = useEngine()
  const w = useWorkspaces()
  const router = useRouter()
  const { open: openLogs } = useLogs()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)

  const items: MenuItem[] = [
    {
      label: "Rename",
      onSelect: async () => {
        const next = await promptDialog({ title: "Rename chat", value: title, confirmLabel: "Save" })
        if (next && next !== title) await renameSession(id, next)
      },
    },
    { label: "Share", onSelect: onShare },
    { label: "Logs", onSelect: openLogs },
    { label: "Chat info", onSelect: () => void alertDialog({ title: "This chat so far", body: `${fmtTokens(totals.tokens)} tokens · ${fmtCost(totals.cost)}` }) },
    "divider",
    {
      label: "Delete chat",
      danger: true,
      onSelect: async () => {
        if (!(await confirmDialog({ title: `Delete "${title}"?`, body: "This cannot be undone.", confirmLabel: "Delete", danger: true }))) return
        await deleteSession(id)
        router.push(w.newChatHref ?? "/")
      },
    },
  ]

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Chat options"
        title="Chat options"
        className={`flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11 expanded:h-8 expanded:w-8 ${open ? "bg-surface-2 text-ink" : ""}`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      <Popover open={open} onClose={close} title={title} side="down" className="absolute top-full right-0 z-30 mt-1.5 w-[220px] overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        <MenuList items={items} onDone={close} />
      </Popover>
    </div>
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
