"use client"

import { useRef, useState, useSyncExternalStore } from "react"
import { usePresence, type Presence } from "@/lib/use-presence"
import { useModalDialog } from "./sheet"

/**
 * In-app replacements for window.confirm / prompt / alert: same one-line await at the call site,
 * but styled, touch-sized and theme-aware. Built on the native <dialog> (showModal), which gives
 * focus trapping, an inert page behind it, the top layer, and focus returning to the trigger.
 *
 *   if (!(await confirmDialog({ title: "Delete chat?", confirmLabel: "Delete", danger: true }))) return
 *   const name = await promptDialog({ title: "Rename chat", value: current, confirmLabel: "Save" })
 *
 * One dialog shows at a time; later requests wait their turn. <DialogHost /> is mounted once in
 * the root layout.
 */

type Base = {
  title: string
  /** Plain text; line breaks are kept. */
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button, and focus starts on Cancel so Enter can't destroy anything by accident. */
  danger?: boolean
}
type PromptOpts = Base & { value?: string; placeholder?: string }

type Request =
  | (Base & { id: number; kind: "confirm"; resolve: (ok: boolean) => void })
  | (Base & { id: number; kind: "alert"; resolve: () => void })
  | (PromptOpts & { id: number; kind: "prompt"; resolve: (value: string | null) => void })

let queue: Request[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function enqueue(r: Request) {
  queue = [...queue, r]
  emit()
}

export function confirmDialog(opts: Base): Promise<boolean> {
  return new Promise((resolve) => enqueue({ ...opts, id: nextId++, kind: "confirm", resolve }))
}

/** Resolves to the trimmed text, or null when cancelled. */
export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => enqueue({ ...opts, id: nextId++, kind: "prompt", resolve }))
}

export function alertDialog(opts: Base): Promise<void> {
  return new Promise((resolve) => enqueue({ ...opts, id: nextId++, kind: "alert", resolve }))
}

/**
 * Shows the first request in the queue, and keeps the one before it on screen while it plays its exit
 * (docs/MOTION.md §4.2). When the next request is already waiting, the old one goes at once and the new one keeps the
 * backdrop where it is: no fade out and back in between them (§4.3).
 */
export function DialogHost() {
  const current = useSyncExternalStore(
    subscribe,
    () => queue[0] ?? null,
    () => null,
  )
  const [shown, setShown] = useState<{ req: Request; open: boolean; instant: boolean } | null>(null)
  let view = shown
  if (current && current !== view?.req) {
    // Adjusting state to the store during render (react.dev, "Storing information from previous renders").
    view = { req: current, open: true, instant: !!view }
    setShown(view)
  } else if (!current && view?.open) {
    view = { ...view, open: false }
    setShown(view)
  }
  if (!view) return null
  const id = view.req.id
  return <DialogView key={id} req={view.req} open={view.open} instantBackdrop={view.instant} onExited={() => setShown((s) => (s?.req.id === id && !s.open ? null : s))} />
}

function DialogView({ req, open, instantBackdrop, onExited }: { req: Request; open: boolean; instantBackdrop: boolean; onExited(): void }) {
  const p = usePresence<HTMLDialogElement>(open, { onExited, handoff: true })
  const done = useRef(false)
  const [text, setText] = useState(req.kind === "prompt" ? (req.value ?? "") : "")

  // The promise resolves on the click, not after the exit, so what comes next (delete, then navigate) isn't held up.
  const finish = (confirmed: boolean) => {
    if (done.current) return
    done.current = true
    if (req.kind === "confirm") req.resolve(confirmed)
    else if (req.kind === "prompt") req.resolve(confirmed ? text.trim() : null)
    else req.resolve()
    queue = queue.filter((r) => r.id !== req.id)
    emit()
  }

  // Mounted only while shown (or leaving), so its modal effect ends when the exit has (useModalDialog releases the page
  // as the exit starts).
  if (!p.mounted) return null
  return <DialogBox req={req} presence={p} instantBackdrop={instantBackdrop} text={text} setText={setText} finish={finish} />
}

function DialogBox({
  req,
  presence: p,
  instantBackdrop,
  text,
  setText,
  finish,
}: {
  req: Request
  presence: Presence<HTMLDialogElement>
  instantBackdrop: boolean
  text: string
  setText(v: string): void
  finish(confirmed: boolean): void
}) {
  useModalDialog(p.ref, p.closing, {
    // Escape and other close requests (the Android back gesture). Escape stops here, so popovers underneath stay open.
    onDismiss: () => finish(false),
    // Closed by the browser (a repeated Escape or back, which the page can't cancel): it is gone already, skip the exit.
    onForcedClose: () => {
      p.skipExit()
      finish(false)
    },
  })

  const isPrompt = req.kind === "prompt"
  const canConfirm = !isPrompt || text.trim().length > 0
  const btn = "rounded-lg px-3.5 py-2 text-[13px] font-medium transition pointer-coarse:min-h-11 pointer-coarse:px-4"

  return (
    <dialog
      {...p.props}
      data-layer
      data-backdrop={instantBackdrop ? "instant" : undefined}
      aria-labelledby={`dlg-${req.id}-title`}
      // A press on the backdrop (the dialog element itself, outside the card) cancels.
      onClick={(e) => e.target === e.currentTarget && finish(false)}
      className="m-auto w-[min(400px,calc(100vw-32px))] max-w-none rounded-2xl border border-line bg-surface p-0 text-ink shadow-card motion-dialog backdrop:bg-black/40 max-medium:mt-[15dvh]"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (canConfirm) finish(true)
        }}
        className="p-5"
      >
        <h2 id={`dlg-${req.id}-title`} className="text-[15px] font-medium leading-6">
          {req.title}
        </h2>
        {req.body && <p className="mt-1.5 whitespace-pre-line text-[13px] leading-5 text-ink-2">{req.body}</p>}
        {isPrompt && (
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder={req.placeholder}
            className="mt-3 w-full rounded-lg border border-line-2 bg-bg px-3 py-2 text-[14px] outline-none focus:border-accent"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          {req.kind !== "alert" && (
            <button type="button" autoFocus={req.danger} onClick={() => finish(false)} className={`${btn} text-ink-2 hover:bg-surface-2`}>
              {req.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            type="submit"
            autoFocus={!isPrompt && !req.danger}
            disabled={!canConfirm}
            className={`${btn} disabled:opacity-40 ${req.danger ? "bg-err text-white hover:opacity-90" : "bg-accent text-accent-ink hover:opacity-90"}`}
          >
            {req.confirmLabel ?? "OK"}
          </button>
        </div>
      </form>
    </dialog>
  )
}
