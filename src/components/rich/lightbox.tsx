"use client"

import { IconButton } from "../ui/s"
import type { ReactNode } from "react"
import { usePresence, type Presence } from "@/lib/use-presence"
import { useModalDialog } from "../ui/sheet"

/**
 * Open, where there is no panel (read-only views; docs/RENDERING.md §2.9): a native <dialog> around the panel view,
 * full screen on phones, Escape or a press on the backdrop closes it. Motion as every dialog (motion-dialog).
 */
export function Lightbox({ open, onClose, label, children }: { open: boolean; onClose(): void; label: string; children: ReactNode }) {
  const p = usePresence<HTMLDialogElement>(open, { handoff: true })
  return p.mounted ? (
    <LightboxView label={label} onClose={onClose} presence={p}>
      {children}
    </LightboxView>
  ) : null
}

function LightboxView({ label, onClose, presence: p, children }: { label: string; onClose(): void; presence: Presence<HTMLDialogElement>; children: ReactNode }) {
  useModalDialog(p.ref, p.closing, {
    onDismiss: onClose,
    onForcedClose: () => {
      p.skipExit()
      onClose()
    },
  })
  return (
    <dialog
      {...p.props}
      data-layer
      aria-label={label}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      // P3 raised dialog from medium up (elevated, hairline, r20, elevation-lg); full screen on phones.
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-elevated p-0 text-ink motion-dialog backdrop:bg-ink/30 medium:m-auto medium:h-[min(88dvh,900px)] medium:w-[min(1100px,calc(100vw-48px))] medium:rounded-xl medium:border medium:border-line medium:shadow-panel"
    >
      <div className="flex h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <div className="flex shrink-0 items-center justify-between border-b border-line py-2 pr-2 pl-5">
          <span className="text-base text-ink">{label}</span>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
      </div>
    </dialog>
  )
}
