"use client"

import { useState } from "react"
import { copyText } from "@/lib/file-actions"
import { KINDS } from "@/lib/rich/kinds"
import { useWindowClass } from "@/lib/use-window-class"
import { Button, IconButton } from "../ui/s"
import { MenuList, Sheet, type MenuItem } from "../ui/sheet"
import type { RichInput } from "./types"

/**
 * A picture's toolbar (docs/RENDERING.md §2.6, §2.8): the kind label, then Open, Copy and Source. With a mouse the
 * buttons show on hover and focus; on touch they always show. Below 600 px there is room for Open and a ⋯ only:
 * Copy, Source and the caption go into a sheet. The buttons are the library's ghost 2xs (24 tall), which carries
 * its own 44 px touch target.
 */

export type BarAction = { label: string; run(): void }

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
          <Button variant="ghost" size="2xs" onClick={onOpen} aria-label={`Open the ${KINDS[input.kind].noun} at full size`}>
            Open
          </Button>
        )}
        {compact ? (
          <>
            <IconButton size="2xs" icon="ellipsis" label={`More for this ${KINDS[input.kind].noun}`} onClick={() => setMore(true)} aria-haspopup="dialog" />
            <Sheet open={more} onClose={() => setMore(false)} title={caption ?? KINDS[input.kind].label}>
              <MenuList items={items} onDone={() => setMore(false)} />
            </Sheet>
          </>
        ) : (
          <>
            <Button variant="ghost" size="2xs" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" size="2xs" onClick={onSource} aria-pressed={sourceOpen}>
              Source
            </Button>
            {actions.map((a) => (
              <Button key={a.label} variant="ghost" size="2xs" onClick={a.run}>
                {a.label}
              </Button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
