"use client"

import { useCallback, useRef, useState, type ReactNode } from "react"
import { IconButton } from "@/components/ui/s"
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
      <IconButton icon="ellipsis" label={label} aria-haspopup="menu" aria-expanded={open} variant={open ? "secondary" : "ghost"} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={close} title={title} label={label} side="down" className="s-raised s-raised--md absolute top-full right-0 z-dropdown mt-1 w-52">
        <MenuList items={items} onDone={close} />
      </Popover>
    </div>
  )
}
