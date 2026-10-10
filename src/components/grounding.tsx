"use client"

import { createContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react"
import type { Chip, Grounding, WebPart } from "@/lib/grounding"
import { holdView, idle, revealing } from "./number-note"

/**
 * Sources under a finished web answer (docs/QUALITY.md Q4): the small part that ships with the chat. It loads
 * src/components/sources.tsx (and the matcher, src/lib/grounding.ts) the first time a finished answer needs it, runs
 * the match when the browser is idle, and turns it on only once the answer has finished typing out: until then the
 * answer renders exactly as before, so nothing here touches streaming, the first token or the typewriter. Local and
 * cloud render the same (one frontend); a shared snapshot gets none of it.
 *
 * What it turns on, through GroundCtx (read by src/components/markdown.tsx): links to pages read become a link plus a
 * numbered chip, and "Sources differ:" / "Not confirmed:" lines become callouts. And the "Read N pages" footer.
 */

type Lib = typeof import("./sources")
let loading: Promise<Lib> | null = null
let loaded: Lib | null = null
const loadLib = () =>
  (loading ??= import("./sources").then((m) => {
    loaded = m
    return m
  }))

export type GroundValue = {
  chipFor(href: string | undefined): Chip | null
  callout(node: unknown): { "data-callout"?: string }
  Chip: ComponentType<{ chip: Chip; href?: string; line?: number; children: ReactNode }>
}
export const GroundCtx = createContext<GroundValue | null>(null)

/** Results by answer text and what was read: a chat opened again isn't matched twice. */
const cache = new Map<string, Grounding>()
const CACHE_MAX = 200
const MAX_CHARS = 100_000


export type WebSources = { turn: WebPart[]; session: WebPart[] }

/**
 * Wraps a finished answer. `text`: the answer's words ("" while it streams or before its turn ends: then this is a
 * plain pass-through). `web`: what the turn and the chat read. `fresh`: the answer streamed in front of the reader.
 */
export function Grounded({ text, web, fresh, children }: { text: string; web?: WebSources; fresh: boolean; children: ReactNode }) {
  const wanted = !!text && !!web && text.length <= MAX_CHARS && (web.turn.length > 0 || /\]\(https?:|https?:\/\//.test(text))
  const sig = wanted ? `${web!.turn.length}:${web!.session.length}:${text}` : ""
  const [result, setResult] = useState<{ sig: string; g: Grounding } | null>(null)
  const [typed, setTyped] = useState(false)
  const marker = useRef<HTMLDivElement>(null)
  const g = !wanted ? null : result?.sig === sig ? result.g : (cache.get(sig) ?? null)

  useEffect(() => {
    if (!wanted || cache.has(sig)) return
    let live = true
    let cancel = () => {}
    loadLib().then(
      (L) => {
        if (!live) return
        cancel = idle(() => {
          if (!live) return
          let out: Grounding = { chips: {}, read: [], flagged: 0 }
          try {
            out = L.compute(text, web!.turn, web!.session)
          } catch {
            // A matcher bug never takes the chat with it.
          }
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
          cache.set(sig, out)
          setResult({ sig, g: out })
        })
      },
      () => {},
    )
    return () => {
      live = false
      cancel()
    }
    // `sig` covers text and web.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, wanted])

  // Matched: wait until the answer has finished typing out ([data-revealing] in this message).
  const has = !!g && (Object.keys(g.chips).length > 0 || g.read.length > 0 || /(?:sources differ|not confirmed)\s*:/i.test(text))
  const waiting = has && !typed
  useEffect(() => {
    const host = marker.current?.parentElement
    if (!waiting || !host) return
    const finish = () => {
      if (revealing(host)) return false
      setTyped(true)
      return true
    }
    let frame = requestAnimationFrame(() => {
      frame = 0
      if (finish()) return
      mo.observe(host, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-revealing"],
      })
    })
    const mo = new MutationObserver(() => {
      if (finish()) mo.disconnect()
    })
    return () => {
      cancelAnimationFrame(frame)
      mo.disconnect()
    }
  }, [waiting])

  const on = has && typed && !!loaded
  const value = useMemo<GroundValue | null>(() => (on && g && loaded ? { chipFor: (href) => loaded!.match(g, href), callout: loaded.callout, Chip: loaded.SourceChip } : null), [on, g])
  useLayoutEffect(() => {
    if (on && g?.read.length && marker.current) holdView(marker.current)
  }, [on, g])

  return (
    <GroundCtx.Provider value={value}>
      {children}
      {on && g && loaded ? (
        <div ref={marker} data-grounded={Object.keys(g.chips).length}>
          <loaded.ReadFooter pages={g.read} chips={g.chips} fresh={fresh} />
        </div>
      ) : (
        <div ref={marker} hidden {...(wanted && (!g || waiting) ? { "aria-busy": true } : {})} />
      )}
    </GroundCtx.Provider>
  )
}
