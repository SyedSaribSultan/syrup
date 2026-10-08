"use client"

import Link from "next/link"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useNarrow } from "@/lib/use-window-class"

/**
 * Bottom sheet (docs/RESPONSIVE.md §7), on the native <dialog>: focus trap,
 * inert page, Escape and the Android back gesture close it. Drag the handle
 * down to dismiss. Full width on phones, 560px and centred on tablets; with
 * `centerOnWide` it becomes a centred dialog from the expanded breakpoint up.
 * Marked data-layer, so a popover underneath (useDismiss) stays open.
 */
export function Sheet(props: { open: boolean; onClose(): void; title?: ReactNode; size?: "fit" | "full"; centerOnWide?: boolean; children: ReactNode; label?: string }) {
  if (!props.open) return null
  return <SheetView {...props} />
}

function SheetView({ onClose, title, size = "fit", centerOnWide, children, label }: { onClose(): void; title?: ReactNode; size?: "fit" | "full"; centerOnWide?: boolean; children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  const [drag, setDrag] = useState(0)
  const start = useRef<number | null>(null)
  useEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (!d.open) d.showModal()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    const onCancel = (e: Event) => {
      e.preventDefault()
      close.current()
    }
    d.addEventListener("keydown", onKey)
    d.addEventListener("cancel", onCancel)
    return () => {
      d.removeEventListener("keydown", onKey)
      d.removeEventListener("cancel", onCancel)
      if (d.open) d.close()
    }
  }, [])

  const height = size === "full" ? "h-[92dvh]" : "max-h-[92dvh]"
  const wide = centerOnWide ? "expanded:my-auto expanded:h-auto expanded:max-h-[80dvh] expanded:max-w-[480px] expanded:rounded-2xl" : ""

  return (
    <dialog
      ref={ref}
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
 * A popover on desktop, a bottom sheet on phones and tablets. The caller keeps its trigger, positioning
 * classes (`className`, applied to the desktop popover) and useDismiss on the wrapper, as before.
 */
export function Popover({ open, onClose, title, className, size, children, label }: { open: boolean; onClose(): void; title?: ReactNode; className: string; size?: "fit" | "full"; children: ReactNode; label?: string }) {
  const narrow = useNarrow()
  if (!open) return null
  if (narrow)
    return (
      <Sheet open onClose={onClose} title={title} size={size} label={label}>
        {children}
      </Sheet>
    )
  return (
    <div className={className} role="dialog" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      {children}
    </div>
  )
}

export type MenuItem =
  | { label: string; onSelect?: () => void; href?: string; icon?: ReactNode; danger?: boolean; hint?: string; disabled?: boolean; external?: boolean }
  | "divider"

/**
 * Rows for a menu: compact in a desktop popover, 48px touch rows in a sheet or on a touch screen.
 * `onDone` runs after a row is chosen (close the menu).
 */
export function MenuList({ items, onDone }: { items: MenuItem[]; onDone(): void }) {
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
            <Link key={it.label} role="menuitem" href={it.href} target={it.external ? "_blank" : undefined} onClick={onDone} className={cls}>
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
