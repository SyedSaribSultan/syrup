"use client"

import { useState } from "react"
import { copyText } from "@/lib/file-actions"
import { KINDS } from "@/lib/rich/kinds"
import { useWindowClass } from "@/lib/use-window-class"
import { MenuList, Sheet, type MenuItem } from "../ui/sheet"
import type { RichInput } from "./types"

/**
 * A picture's toolbar (docs/RENDERING.md §2.6, §2.8): the kind label, then Open, Copy and Source. With a mouse the
 * buttons show on hover and focus; on touch they always show, 44 px each. Below 600 px there is room for Open and a
 * ⋯ only: Copy, Source and the caption go into a sheet.
 */

export type BarAction = { label: string; run(): void }

const btn = "flex items-center justify-center rounded-md px-2 py-0.5 text-[12px] text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3"

export function Toolbar({ input, caption, onOpen, onSource, sourceOpen, actions = [] }: { input: RichInput; caption?: string; onOpen?: () => void; onSource(): void; sourceOpen: boolean; actions?: BarAction[] }) {
  const compact = useWindowClass() === "compact"
  const [copied, setCopied] = useState(false)
  const [more, setMore] = useState(false)
  const copy = () =>
    void copyText(input.source).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  const items: MenuItem[] = [
    { label: copied ? "Copied" : "Copy source", onSelect: copy },
    { label: sourceOpen ? "Hide source" : "Show source", onSelect: onSource },
    ...actions.map((a) => ({ label: a.label, onSelect: a.run })),
  ]
  return (
    <div className="rich-bar">
      <span className="rich-kind">{KINDS[input.kind].label}</span>
      {caption && <span className="rich-cap">{caption}</span>}
      <span className="flex-1" />
      <div className="flex items-center gap-0.5 transition pointer-fine:opacity-0 pointer-fine:group-hover/rich:opacity-100 pointer-fine:focus-within:opacity-100">
        {onOpen && (
          <button type="button" className={btn} onClick={onOpen} aria-label={`Open the ${KINDS[input.kind].noun} at full size`}>
            Open
          </button>
        )}
        {compact ? (
          <>
            <button type="button" className={btn} onClick={() => setMore(true)} aria-label={`More for this ${KINDS[input.kind].noun}`} aria-haspopup="dialog">
              ⋯
            </button>
            <Sheet open={more} onClose={() => setMore(false)} title={caption ?? KINDS[input.kind].label}>
              <MenuList items={items} onDone={() => setMore(false)} />
            </Sheet>
          </>
        ) : (
          <>
            <button type="button" className={btn} onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className={btn} onClick={onSource} aria-pressed={sourceOpen}>
              Source
            </button>
            {actions.map((a) => (
              <button key={a.label} type="button" className={btn} onClick={a.run}>
                {a.label}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
