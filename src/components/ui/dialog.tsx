"use client"

import { Button } from "./s"
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

  return (
    <dialog
      {...p.props}
      data-layer
      data-backdrop={instantBackdrop ? "instant" : undefined}
      aria-labelledby={`dlg-${req.id}-title`}
      // A press on the backdrop (the dialog element itself, outside the card) cancels.
      onClick={(e) => e.target === e.currentTarget && finish(false)}
      // P3 raised dialog (03 B14): elevated surface, hairline, r20, elevation-lg, ink 30% scrim.
      className="m-auto w-[min(440px,calc(100vw-32px))] max-w-none rounded-xl border border-line bg-elevated p-0 text-ink shadow-panel motion-dialog backdrop:bg-ink/30 max-medium:mt-[15dvh]"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (canConfirm) finish(true)
        }}
        className="p-6"
      >
        <h2 id={`dlg-${req.id}-title`} className="text-xl text-ink">
          {req.title}
        </h2>
        {req.body && <p className="mt-2 whitespace-pre-line text-base text-ink-2">{req.body}</p>}
        {isPrompt && (
          <div className="s-field mt-4">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder={req.placeholder}
            aria-label={req.title}
            className="s-field__input"
          />
          </div>
        )}
        {/* Actions right; stacked below 480 with the confirm on top. Cancel secondary, confirm primary, destructive error. */}
        <div className="mt-6 flex flex-col-reverse gap-2 min-[480px]:flex-row min-[480px]:justify-end">
          {req.kind !== "alert" && (
            <Button variant="secondary" autoFocus={req.danger} onClick={() => finish(false)}>
              {req.cancelLabel ?? "Cancel"}
            </Button>
          )}
          <Button type="submit" variant={req.danger ? "error" : "primary"} autoFocus={!isPrompt && !req.danger} disabled={!canConfirm}>
            {req.confirmLabel ?? "OK"}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
