"use client"

import { useCallback, useRef, useState, type ReactNode } from "react"
import { MenuList, Popover, type MenuItem } from "@/components/ui/sheet"
import { useDismiss } from "@/lib/use-dismiss"

/**
 * A row's ⋯ button: its actions as a bottom sheet on phones and tablets, a
 * small popover under the button on desktop. For rows too narrow to show
 * their action buttons inline (docs/RESPONSIVE.md §9).
 */
export function RowMenu({ items, label = "More actions", title, className = "" }: { items: MenuItem[]; label?: string; title?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  return (
    <div ref={ref} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
          <circle cx="3" cy="7" r="1.25" />
          <circle cx="7" cy="7" r="1.25" />
          <circle cx="11" cy="7" r="1.25" />
        </svg>
      </button>
      <Popover open={open} onClose={close} title={title} label={label} side="down" className="absolute top-full right-0 z-30 mt-1 w-52 rounded-xl border border-line bg-surface shadow-card">
        <MenuList items={items} onDone={close} />
      </Popover>
    </div>
  )
}
