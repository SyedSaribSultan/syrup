"use client"

import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ground, chipKey, pagesFrom, sourceFlagsEnabled, type Chip, type Grounding, type Page, type WebPart } from "@/lib/grounding"
import { usePresence } from "@/lib/use-presence"

/**
 * The sources of a finished web answer (docs/QUALITY.md Q4), loaded in its own chunk the first time a finished answer
 * needs it (src/components/grounding.tsx). Numbered chips after links to pages syrup read, each opening a card with
 * the page's title, host, the day it was read and the passage that matches the line; a soft flag on a chip whose line
 * gives an amount the page doesn't; a "Read N pages" footer.
 *
 * Every string from a page is rendered as React text, never as HTML: a fetched page is untrusted input. Links open
 * only http(s) URLs, with no referrer and no opener.
 */

export function compute(text: string, turn: WebPart[], session: WebPart[]): Grounding {
  return ground(text, pagesFrom(turn), pagesFrom(session))
}

export function match(g: Grounding, href: string | undefined): Chip | null {
  const k = chipKey(href)
  return (k && g.chips[k]) || null
}

const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined)

/** The card: fixed to the viewport under (or over) its chip, never wider than the screen less 16 px a side. */
function Card({ chip, flags, anchor, onClose, id }: { chip: Chip; flags: string[]; anchor: HTMLElement; onClose: () => void; id: string }) {
  const p = usePresence<HTMLDivElement>(true)
  const [at, setAt] = useState<{
    left: number
    top: number
    side: "up" | "down"
    width: number
  } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = window.innerHeight
      const width = Math.min(320, vw - 32)
      const h = p.ref.current?.offsetHeight ?? 160
      const below = r.bottom + 6 + h <= vh - 8 || r.top - 6 - h < 8
      setAt({
        left: Math.max(16, Math.min(r.left + r.width / 2 - width / 2, vw - 16 - width)),
        top: below ? r.bottom + 6 : r.top - 6 - h,
        side: below ? "down" : "up",
        width,
      })
    }
    place()
    // It follows its chip while the chat scrolls (one placement per frame); the chip scrolled out of view closes it.
    let frame = 0
    const follow = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const r = anchor.getBoundingClientRect()
        if (r.bottom < 0 || r.top > window.innerHeight) onClose()
        else place()
      })
    }
    window.addEventListener("resize", follow)
    window.addEventListener("scroll", follow, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", follow)
      window.removeEventListener("scroll", follow, true)
    }
  }, [anchor, onClose, p.ref])
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (!p.ref.current?.contains(t) && !anchor.contains(t)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose()
        anchor.querySelector("button")?.focus()
      }
    }
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("keydown", key, true)
    return () => {
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("keydown", key, true)
    }
  }, [anchor, onClose, p.ref])
  const { page, snippet } = chip
  const href = safeHref(page.url)
  return createPortal(
    <div
      {...p.props}
      id={id}
      role="dialog"
      aria-label={`Source ${chip.n}: ${page.title || page.host}`}
      data-source-card
      data-side={at?.side ?? "down"}
      style={{
        left: at?.left ?? -9999,
        top: at?.top ?? 0,
        width: at?.width ?? 320,
      }}
      className="fixed z-[60] rounded-xl border border-line bg-surface p-3 text-[13px] leading-5 text-ink-2 shadow-card motion-pop [overflow-wrap:anywhere]"
    >
      <p className="font-medium text-ink">{page.title || page.host}</p>
      <p className="mt-0.5 text-[11px] text-muted">
        {page.host}
        {page.via === "fetch" ? (page.fetched ? ` · read ${page.fetched}` : " · read") : " · from a search result"}
      </p>
      {snippet && (
        <p className="mt-2 border-l-2 border-line-2 pl-2 text-ink-2">
          {snippet.before}
          {snippet.match && <mark className="rounded-sm bg-accent/15 px-0.5 text-ink">{snippet.match}</mark>}
          {snippet.after}
        </p>
      )}
      {flags.length > 0 && (
        <p data-source-flag className="mt-2 flex gap-1.5 text-ink-2">
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
          <span>{flags.length === 1 ? `${flags[0]} isn't` : `${flags.slice(0, 3).join(", ")} aren't`} in what syrup read from this page. It may come from another page or be worked out.</span>
        </p>
      )}
      {href && (
        <a href={href} target="_blank" rel="noreferrer noopener" className="mt-2 inline-block text-[12px] font-medium text-accent underline underline-offset-2">
          Open page
        </a>
      )}
    </div>,
    document.body,
  )
}

/** The chip after a link to a page syrup read: the link stays as written, the number opens the card. */
export function SourceChip({ chip, href, line, children }: { chip: Chip; href?: string; line?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [wrap, setWrap] = useState<HTMLSpanElement | null>(null)
  const id = `source-card-${chip.n}-${chip.page.id.length}`
  const target = safeHref(href ?? "") ?? safeHref(chip.page.url)
  // The flag sits on the chip of the line that gives the amount (all of the page's chips if the line is unknown).
  const flags = !sourceFlagsEnabled() ? [] : line === undefined ? chip.flags : (chip.flagsByLine[line] ?? [])
  const flagged = flags.length > 0
  const onClose = useCallback(() => setOpen(false), [])
  return (
    <span ref={setWrap} className="whitespace-nowrap" data-source={chip.n}>
      <a href={target} target="_blank" rel="noreferrer noopener" className="whitespace-normal">
        {children}
      </a>
      <button
        type="button"
        aria-label={`Source ${chip.n}: ${chip.page.title || chip.page.host}${flagged ? ", a number on this line isn't on the page" : ""}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-source-chip
        data-flagged={flagged || undefined}
        onClick={() => setOpen((o) => !o)}
        className={`relative ml-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] -translate-y-px items-center justify-center rounded-full border px-1 align-middle font-sans text-[10.5px] leading-none font-medium transition hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-[''] ${flagged ? "border-warn/50 bg-warn/10 text-ink-2" : "border-line bg-surface-2 text-ink-2"}`}
      >
        {chip.n}
        {flagged && <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />}
      </button>
      {open && wrap && <Card chip={chip} flags={flags} anchor={wrap} onClose={onClose} id={id} />}
    </span>
  )
}

/** "Read N pages": what this answer's turn read, collapsed. Fades in when the answer streamed in front of the reader. */
export function ReadFooter({ pages: read, chips, fresh }: { pages: Page[]; chips: Grounding["chips"]; fresh: boolean }) {
  // Pages the answer cites first, under their chip's number; then the rest, unnumbered.
  const num = (p: Page) => chips[p.id]?.n ?? Infinity
  const pages = [...read].sort((a, b) => num(a) - num(b))
  if (!pages.length) return null
  const fetched = pages.filter((p) => p.via === "fetch").length
  return (
    <details data-read-pages {...(fresh ? { "data-state": "open", "data-side": "down" } : {})} className={`${fresh ? "motion-notice " : ""}group/read mt-2 text-[12px] text-muted`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md py-0.5 transition select-none hover:text-ink-2 pointer-coarse:py-2 [&::-webkit-details-marker]:hidden">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="transition group-open/read:rotate-90">
          <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Read {pages.length} page{pages.length === 1 ? "" : "s"}
        {fetched < pages.length && fetched > 0 ? ` (${fetched} opened)` : ""}
      </summary>
      <ul className="mt-1 space-y-1 [overflow-wrap:anywhere]">
        {pages.map((p) => (
          <li key={p.id} className="flex gap-1.5">
            <span className="w-4 shrink-0 text-right tabular-nums" aria-hidden>
              {chips[p.id] ? chips[p.id].n : "·"}
            </span>
            <span className="min-w-0">
              {safeHref(p.url) ? (
                <a href={safeHref(p.url)} target="_blank" rel="noreferrer noopener" className="text-ink-2 underline decoration-line-2 underline-offset-2 hover:text-ink">
                  {p.title || p.host}
                </a>
              ) : (
                <span className="text-ink-2">{p.title || p.host}</span>
              )}
              <span> · {p.host}</span>
              {p.via === "search" && <span> · search result</span>}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

type HastNode = { type: string; value?: string; tagName?: string; children?: HastNode[] }

/** The first words of a paragraph or list item, through any bold or italic wrapping them. */
function leadText(node: HastNode | undefined, depth = 0): string {
  if (!node || depth > 4) return ""
  let out = ""
  for (const c of node.children ?? []) {
    if (c.type === "text") out += c.value ?? ""
    else if (c.type === "element" && (c.tagName === "strong" || c.tagName === "em" || c.tagName === "b" || c.tagName === "p")) out += leadText(c, depth + 1)
    else break
    if (out.length > 40) break
  }
  return out
}

const CALLOUT = /^\s*(sources differ|not confirmed)\s*:/i

/**
 * "Sources differ:" and "Not confirmed:" lines (the web rules' fixed phrases) as quiet callouts, once the answer is
 * grounded. Drawn with an inset edge and a tint inside negative margins: the text doesn't move when they appear.
 */
export function callout(node: unknown): { "data-callout"?: string } {
  const m = CALLOUT.exec(leadText(node as HastNode))
  return m ? { "data-callout": m[1].toLowerCase().startsWith("sources") ? "differ" : "unconfirmed" } : {}
}
