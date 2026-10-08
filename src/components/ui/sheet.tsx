"use client"

import Link from "next/link"
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react"
import { focusReturn, noteOpener, OverlayContext, restartEntrance, useOverlay, usePresence, type Presence } from "@/lib/use-presence"
import { useNarrow } from "@/lib/use-window-class"

/**
 * Bottom sheet (docs/RESPONSIVE.md §7), on the native <dialog>: focus trap,
 * inert page, Escape and the Android back gesture close it. Drag the handle
 * down to dismiss. Full width on phones, 560px and centred on tablets; with
 * `centerOnWide` it becomes a centred dialog from the expanded breakpoint up.
 * Marked data-layer, so a popover underneath (useDismiss) stays open.
 *
 * Motion (docs/MOTION.md §4.2, §5): it rises in and slides out (motion-sheet). When the exit starts it stops being modal
 * but stays in the top layer (useModalDialog), so the page takes taps again at once and focus goes back to the opener.
 * A `close` the browser forces (a repeated Escape or Android back, which the page can't cancel) skips the exit.
 */
export function Sheet({ open, onExited, ...rest }: { open: boolean; onClose(): void; onExited?(): void; title?: ReactNode; size?: "fit" | "full"; centerOnWide?: boolean; children: ReactNode; label?: string }) {
  const p = usePresence<HTMLDialogElement>(open, { onExited, handoff: true })
  // Mounted only while shown or leaving, so its modal effect ends after the exit.
  if (!p.mounted) return null
  return (
    <OverlayContext.Provider value={p}>
      <SheetView {...rest} presence={p} />
    </OverlayContext.Provider>
  )
}

function SheetView({
  onClose,
  title,
  size = "fit",
  centerOnWide,
  children,
  label,
  presence: p,
}: {
  onClose(): void
  title?: ReactNode
  size?: "fit" | "full"
  centerOnWide?: boolean
  children: ReactNode
  label?: string
  presence: Presence<HTMLDialogElement>
}) {
  const [drag, setDrag] = useState(0)
  const start = useRef<number | null>(null)
  useModalDialog(p.ref, p.closing, {
    onDismiss: onClose,
    // Closed by the browser: it is gone already, so skip the exit.
    onForcedClose: () => {
      p.skipExit()
      onClose()
    },
  })

  const height = size === "full" ? "h-[92dvh]" : "max-h-[92dvh]"
  const wide = centerOnWide ? "expanded:my-auto expanded:h-auto expanded:max-h-[80dvh] expanded:max-w-[480px] expanded:rounded-2xl" : ""

  return (
    <dialog
      {...p.props}
      data-layer
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={drag ? { translate: `0 ${drag}px`, transition: "none" } : undefined}
      className={`mx-auto mt-auto mb-0 w-full max-w-none overflow-hidden rounded-t-2xl border border-b-0 border-line bg-surface p-0 text-ink shadow-card motion-sheet backdrop:bg-black/40 medium:max-w-[560px] ${height} ${wide}`}
    >
      <div className={`flex flex-col pb-[env(safe-area-inset-bottom)] ${size === "full" ? "h-full" : "max-h-[92dvh]"}`}>
        <div
          className={`flex shrink-0 cursor-grab touch-none justify-center pt-2.5 pb-1.5 ${centerOnWide ? "expanded:hidden" : ""}`}
          onPointerDown={(e) => {
            start.current = e.clientY
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => start.current !== null && setDrag(Math.max(0, e.clientY - start.current))}
          onPointerUp={() => {
            const d = drag
            start.current = null
            setDrag(0)
            // Released past 80px: the exit slides on from where the finger let go.
            if (d > 80) onClose()
          }}
          onPointerCancel={() => {
            start.current = null
            setDrag(0)
          }}
        >
          <span className="h-1 w-10 rounded-full bg-line-2" />
        </div>
        {title && <div className="shrink-0 px-5 pt-1 pb-2 text-[15px] font-medium text-ink">{title}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </dialog>
  )
}

/**
 * A native <dialog> shown modal while the calling component is mounted and not `closing` (Sheet, Dialog: they mount it
 * only while shown or leaving, docs/MOTION.md §4.2).
 * - Escape and other close requests (`cancel`, e.g. the Android back gesture) call `onDismiss`; Escape stops at the
 *   dialog, so a popover underneath (useDismiss listens on document) stays open.
 * - A `close` the browser forces (a repeated Escape or back without user activation, where `cancel` can't be cancelled)
 *   calls `onForcedClose`: the dialog is gone already, so the caller skips its exit.
 * - When its exit starts (`closing`), it stops being modal but stays on screen: close() then showPopover(), so it keeps
 *   painting in the top layer, over everything, while it slides or fades out, but the page is live again at once. A tap
 *   or a key during the exit reaches the page (§8), and focus goes back to the opener then, not after the exit.
 *   Opened again while leaving, it goes back to modal. Without the Popover API (Chrome 114, Safari 17, Firefox 125) it
 *   stays modal until the exit ends.
 * - On unmount, which comes after the exit: hidePopover() or close() (a layout effect, so before React removes the
 *   element), and focus goes back to the opener if it is still nowhere.
 * - The opener is what had focus when it opened. When that was an item of a menu that handed off to it and has gone
 *   since (a phone's chat ⋯ sheet → Delete chat), it is that menu's opener (focusReturn, src/lib/use-presence.ts).
 */
export function useModalDialog(ref: RefObject<HTMLDialogElement | null>, closing: boolean, handlers: { onDismiss(): void; onForcedClose(): void }) {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  /** Leaving as a popover: modality released (see `closing` above). */
  const released = useRef(false)
  /** What had focus when it opened (or opened again). */
  const before = useRef<Element | null>(null)

  useLayoutEffect(() => {
    const d = ref.current
    if (!d) return
    // Not a node ref: the cleanup reads the opener as it is then, which a re-open during the exit may have noted again.
    const opener = before
    noteBefore(d, opener)
    if (!d.open) d.showModal()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      latest.current.onDismiss()
    }
    const onCancel = (e: Event) => {
      e.preventDefault()
      latest.current.onDismiss()
    }
    // `close` is queued as a task, so a stale one can arrive after the dialog was shown again (React's development
    // re-run of effects closes and reopens it): only a dialog that is really closed counts. Releasing it for the exit
    // closes it too, on purpose.
    const onClose = () => {
      if (!d.open && !released.current) latest.current.onForcedClose()
    }
    d.addEventListener("keydown", onKey)
    d.addEventListener("cancel", onCancel)
    d.addEventListener("close", onClose)
    return () => {
      d.removeEventListener("keydown", onKey)
      d.removeEventListener("cancel", onCancel)
      d.removeEventListener("close", onClose)
      if (released.current) {
        released.current = false
        if (d.matches(":popover-open")) d.hidePopover()
      } else if (d.open) d.close()
      giveFocusBack(d, opener.current)
    }
  }, [ref])

  useLayoutEffect(() => {
    const d = ref.current
    if (!d) return
    if (closing && d.open && !released.current && typeof d.showPopover === "function") {
      released.current = true
      swapLayer(d, () => {
        d.setAttribute("popover", "manual")
        d.close()
        d.showPopover()
      })
      giveFocusBack(d, before.current)
    } else if (!closing && released.current) {
      // Opened again during its exit: modal again, from where the exit had got to.
      released.current = false
      noteBefore(d, before)
      swapLayer(d, () => {
        d.hidePopover()
        d.removeAttribute("popover")
        d.showModal()
      })
    }
  }, [closing, ref])
}

/**
 * Moves a shown dialog between modal and popover (useModalDialog). It never stops displaying in between
 * (`data-layer-swap`, globals.css), so its transitions carry on from where they are instead of starting over, and its
 * new ::backdrop starts from the old one's opacity (`--backdrop-from`).
 */
function swapLayer(d: HTMLDialogElement, swap: () => void) {
  d.style.setProperty("--backdrop-from", getComputedStyle(d, "::backdrop").opacity)
  d.dataset.layerSwap = ""
  try {
    swap()
  } finally {
    delete d.dataset.layerSwap
  }
}

/**
 * Notes what has focus now as the dialog's opener, unless it already has one and focus is inside the dialog or nowhere.
 * - Inside: React's development re-run of the modal effect comes after showModal() moved focus in, and must not replace
 *   the real opener with the dialog's own button (focus would go back there, then to <body> once the dialog has gone).
 * - Nowhere: opened again during its exit by a tap, which Safari doesn't focus (it blurs what had focus instead). The
 *   opener it had is still the one.
 */
function noteBefore(d: HTMLDialogElement, before: { current: Element | null }) {
  const now = document.activeElement
  if (before.current && (!now || now === document.body || d.contains(now))) return
  before.current = now
  noteOpener(d, now)
}

/** Focus back to the dialog's opener, unless something outside the dialog has taken it already. */
function giveFocusBack(d: HTMLDialogElement, before: Element | null) {
  const now = document.activeElement
  if (now && now !== document.body && !d.contains(now)) return
  focusReturn(before)?.focus({ preventScroll: true })
}

/** Where a popover opens from its trigger: the way it travels in, and its transform-origin (docs/MOTION.md §4.5). */
export type Side = "up" | "down" | "right" | "auto"

/**
 * A popover on desktop, a bottom sheet on phones and tablets. The caller keeps its trigger, positioning
 * classes (`className`, applied to the desktop popover) and useDismiss on the wrapper, as before.
 * `side` is where it opens from its trigger: up (it sits above), down (below), right (beside, e.g. out of the rail).
 * "auto" reads it from where `className` put it, on open.
 */
export function Popover({
  open,
  onClose,
  onExited,
  title,
  className,
  style,
  side = "auto",
  size,
  children,
  label,
}: {
  open: boolean
  onClose(): void
  onExited?(): void
  title?: ReactNode
  className: string
  style?: CSSProperties
  side?: Side
  size?: "fit" | "full"
  children: ReactNode
  label?: string
}) {
  const narrow = useNarrow()
  if (narrow)
    return (
      <Sheet open={open} onClose={onClose} onExited={onExited} title={title} size={size} label={label}>
        {children}
      </Sheet>
    )
  return (
    <PopoverPanel open={open} onExited={onExited} className={className} style={style} side={side} label={label ?? (typeof title === "string" ? title : undefined)}>
      {children}
    </PopoverPanel>
  )
}

function PopoverPanel({ open, onExited, className, style, side, label, children }: { open: boolean; onExited?(): void; className: string; style?: CSSProperties; side: Side; label?: string; children: ReactNode }) {
  const p = usePresence<HTMLDivElement>(open, { onExited, handoff: true })
  const { mounted, ref } = p

  // side="auto": where the caller's classes put it, measured before the first paint. Measuring starts the entrance
  // without a side, so it is restarted with the side written (restartEntrance).
  useLayoutEffect(() => {
    const el = ref.current
    if (!mounted || side !== "auto" || !el?.offsetParent) return
    const r = el.getBoundingClientRect()
    const a = el.offsetParent.getBoundingClientRect()
    el.dataset.side = r.bottom <= a.top + 1 ? "up" : r.left >= a.right - 1 ? "right" : "down"
    restartEntrance(el)
  }, [mounted, side, ref])

  if (!mounted) return null
  return (
    <OverlayContext.Provider value={p}>
      <div {...p.props} data-side={side === "auto" ? undefined : side} className={`${className} motion-pop`} style={style} role="dialog" aria-label={label}>
        {children}
      </div>
    </OverlayContext.Provider>
  )
}

/**
 * A menu row. `handoff`: choosing it hands over to something that is not an overlay of ours (the native file picker, the
 * phone's panel layer), so the menu closes without its exit (docs/MOTION.md §4.3). Rows with `href` navigate, so they
 * always do. Rows that open a Dialog, Sheet, Popover or the Logs viewer need nothing: that overlay ends the exit itself.
 */
export type MenuItem =
  | { label: string; onSelect?: () => void; href?: string; icon?: ReactNode; danger?: boolean; hint?: string; disabled?: boolean; external?: boolean; handoff?: boolean }
  | "divider"

/**
 * Rows for a menu: compact in a desktop popover, 48px touch rows in a sheet or on a touch screen.
 * `onDone` runs after a row is chosen (close the menu).
 */
export function MenuList({ items, onDone }: { items: MenuItem[]; onDone(): void }) {
  const overlay = useOverlay()
  const row =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition hover:bg-surface-2 disabled:opacity-40 max-expanded:px-4 max-expanded:py-3 max-expanded:text-[15px] pointer-coarse:py-3"
  return (
    <div role="menu" className="p-1.5 max-expanded:px-2 max-expanded:pb-3">
      {items.map((it, i) => {
        if (it === "divider") return <div key={`d${i}`} role="separator" className="mx-2 my-1 border-t border-line" />
        const body = (
          <>
            {it.icon && <span className="flex w-4 shrink-0 justify-center text-muted">{it.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className="shrink-0 text-[11px] text-muted">{it.hint}</span>}
          </>
        )
        const cls = `${row} ${it.danger ? "text-err" : "text-ink"}`
        if (it.href)
          return (
            <Link
              key={it.label}
              role="menuitem"
              href={it.href}
              target={it.external ? "_blank" : undefined}
              onClick={() => {
                overlay?.skipExit()
                onDone()
              }}
              className={cls}
            >
              {body}
            </Link>
          )
        return (
          <button
            key={it.label}
            role="menuitem"
            type="button"
            disabled={it.disabled}
            onClick={() => {
              if (it.handoff) overlay?.skipExit()
              onDone()
              it.onSelect?.()
            }}
            className={cls}
          >
            {body}
          </button>
        )
      })}
    </div>
  )
}
