"use client"

import { loadCore, useLazy } from "@/lib/rich/lazy"
import type { PanelBlock } from "@/lib/panel"
import { Brew } from "../brew"
import { RichBoundary } from "./slot"

/**
 * A chat block at full size in the Preview tab (docs/RENDERING.md §2.8): the core's panel view, with its zoom and
 * scrolling. A block opened before a reload is gone (the URL holds only its key): say so instead of a blank tab.
 */
/** Opening a block moves focus into the panel (§2.13), unless something in the panel already has it (the phone layer's ✕). */
function focusOnOpen(el: HTMLDivElement | null) {
  if (el && !el.closest("[aria-label='Workspace panel']")?.contains(document.activeElement)) el.focus({ preventScroll: true })
}

export function BlockPreview({ block }: { block: PanelBlock | null }) {
  const core = useLazy(loadCore)
  const C = core.module
  if (!block || !("input" in block))
    return <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">This preview is gone after the reload. Open it again from the chat.</div>
  if (core.failed)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">
        Couldn&apos;t load the diagram viewer.{" "}
        <button type="button" className="rich-link" onClick={core.retry}>
          Retry
        </button>
      </div>
    )
  if (!C)
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Brew mood="load" size="md" />
      </div>
    )
  return (
    <div ref={focusOnOpen} key={block.key} tabIndex={-1} aria-label={`${block.input.kind === "svg" ? "Picture" : "Diagram"} at full size`} className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-3 outline-none">
      <RichBoundary fallback={<p className="rich-note">Couldn&apos;t draw this {block.input.kind}.</p>}>
        <C.RichView key={block.key} input={block.input} />
      </RichBoundary>
    </div>
  )
}
