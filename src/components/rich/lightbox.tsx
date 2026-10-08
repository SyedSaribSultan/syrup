"use client"

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
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-surface p-0 text-ink motion-dialog backdrop:bg-black/50 medium:m-auto medium:h-[min(88dvh,900px)] medium:w-[min(1100px,calc(100vw-48px))] medium:rounded-2xl medium:border medium:border-line medium:shadow-card"
    >
      <div className="flex h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1.5">
          <span className="text-[13px] font-medium text-ink">{label}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11">
            <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
      </div>
    </dialog>
  )
}
