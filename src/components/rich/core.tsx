"use client"

import posthog from "posthog-js"
import { createElement, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react"
import { usePanel } from "@/lib/panel"
import { KINDS } from "@/lib/rich/kinds"
import { hash } from "@/lib/rich/fence"
import { mermaidTooLargeForChat } from "@/lib/rich/mermaid-guard"
import { ensure, loadKatex, useLazy } from "@/lib/rich/lazy"
import { loadRenderer } from "@/lib/rich/loaders"
import { useResolvedScheme } from "@/lib/theme"
import { clog } from "@/lib/clientlog"
import { CodeBlock } from "../markdown"
import { useReadOnly } from "../read-only"
import { cacheKey, drop, obtain, peek, type Outcome } from "./cache"
import { Lightbox } from "./lightbox"
import { RenderDropped, RenderTimeout, schedule } from "./scheduler"
import { ExportPicture, ImgPicture, Picture } from "./shadow-markup"
import { ExportContext, RichSkeleton } from "./slot"
import { LIGHT_TOKENS, readTokens } from "./theme-tokens"
import { Toolbar } from "./toolbar"
import type { ExportItems, Renderer, RendererModule, RichInput, RichSurface, StaticRender, ThemeTokens } from "./types"

/**
 * The lazy rich core (docs/RENDERING.md §2.2): every surface draws through it. RichBlock in the chat, RichView in the
 * panel and the lightbox, RichCollect / RichExport / prerenderForExport for the HTML export. A block validates, tries
 * the deterministic fixes, renders once per (kind, version, theme, width, source) and is cached; it shows its source
 * and a note when it can't be drawn, never an error the reader can't act on.
 */

const CHAT_MAX_HEIGHT = 600

// ---------------------------------------------------------------- rendering

const NOTES: Record<string, (noun: string) => string> = {
  parse: (n) => `This ${n} has a syntax error, so here's its source.`,
  schema: (n) => `This ${n} has a syntax error, so here's its source.`,
  "cut-off": (n) => `This ${n} was cut off.`,
  "too-large": () => "Too large to draw here.",
  empty: (n) => (n === "picture" ? "This SVG had nothing safe to show." : `This ${n} is empty.`),
  remote: (n) => (n === "chart" ? "Charts here can't load data from the web." : `This ${n} asks to load something from the web, so here's its source.`),
  render: (n) => `Couldn't draw this ${n}.`,
  timeout: (n) => `Couldn't draw this ${n}.`,
  load: (n) => `Couldn't load the ${n} viewer.`,
}

/** Notes that replace the parser's message, and those that show it under the note. */
const SOURCE_NOTES = new Set(["parse", "schema", "cut-off", "remote", "empty", "too-large"])
const DETAIL_NOTES = new Set(["parse", "schema", "remote"])

function note(input: RichInput, code: string): string {
  const noun = KINDS[input.kind].noun
  return (NOTES[code] ?? NOTES.render)(noun)
}

function track(event: string, props: Record<string, unknown>) {
  try {
    if ((posthog as unknown as { __loaded?: boolean }).__loaded) posthog.capture(event, props)
  } catch {}
}

/** Validate → autofix → static picture, in the render queue. Expected failures become outcomes, never console errors. */
function produce(renderer: Renderer, input: RichInput, tokens: ThemeTokens, surface: RichSurface, cut: boolean, wanted?: () => boolean): Promise<Outcome | null> {
  const t0 = performance.now()
  return schedule(async (signal) => {
    let v = await renderer.validate(input, signal)
    let source = input.source
    let repaired: "autofix" | undefined
    if (!v.ok) {
      if (cut) return { state: "source", error: { ...v.error, code: "cut-off", repairable: false } } as Outcome
      if (v.error.repairable && renderer.autofix) {
        for (const candidate of renderer.autofix(input.source, v.error)) {
          const again = await renderer.validate({ ...input, source: candidate }, signal)
          if (again.ok) {
            v = again
            source = candidate
            repaired = "autofix"
            break
          }
        }
      }
      if (!v.ok) {
        clog("rich.invalid", { kind: input.kind, code: v.error.code, message: v.error.message })
        return { state: "source", error: v.error } as Outcome
      }
    }
    if (!renderer.toStatic) throw new Error(`${input.kind} has no static picture`)
    const render = await renderer.toStatic(v.value, { surface, tokens, width: 0, signal })
    return { state: "ready", render, repaired, source, warnings: v.warnings } as Outcome
  }, { wanted }).then(
    (o) => {
      track("rich_block_render", { kind: input.kind, ms: Math.round(performance.now() - t0), ok: o.state === "ready", repaired: o.state === "ready" ? (o.repaired ?? null) : null })
      return o
    },
    (err: unknown) => {
      if (err instanceof RenderDropped) return null
      const timeout = err instanceof RenderTimeout
      clog("rich.render_failed", { kind: input.kind, error: err instanceof Error ? err.message : String(err) }, { level: "warn" })
      track("rich_block_error", { kind: input.kind, code: timeout ? "timeout" : "render" })
      return { state: "error", error: { code: timeout ? "timeout" : "render", message: err instanceof Error ? err.message : String(err), repairable: false } } as Outcome
    },
  )
}

function keyFor(renderer: Renderer, input: RichInput, scheme: string, cut: boolean) {
  return cacheKey(input.kind, renderer.version, scheme, null, `${cut ? "cut:" : ""}${hash(input.source)}`)
}

/**
 * The outcome for a block, rendered on first read and shared by every copy. While a new theme's picture renders, the
 * previous one stays (never back to a skeleton).
 */
function useOutcome(renderer: Renderer | null, input: RichInput, scheme: "light" | "dark", surface: RichSurface, cut: boolean): { outcome: Outcome | null; retry(): void } {
  const [nonce, setNonce] = useState(0)
  const key = renderer ? keyFor(renderer, input, scheme, cut) : null
  const subscribe = useCallback(
    (f: () => void) => {
      if (!key || !renderer) return () => {}
      // Renders wait in one queue; one whose block has left the screen by its turn is dropped (rendered again if it comes back).
      const entry = obtain(key, (e) => produce(renderer, input, readTokens(scheme), surface, cut, () => e.subs.size > 0))
      entry.subs.add(f)
      if (entry.outcome) queueMicrotask(f)
      return () => {
        entry.subs.delete(f)
      }
    },
    // `nonce`: Retry dropped the entry; subscribing again renders anew.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, nonce],
  )
  const outcome = useSyncExternalStore(subscribe, () => (key ? peek(key) : null), () => null)
  // The last outcome shown, with its key: a new theme's picture keeps the old one until it is ready, and a block whose
  // entry left the cache (the LRU) keeps its settled state instead of falling back to a busy skeleton.
  const [last, setLast] = useState<{ key: string | null; outcome: Outcome } | null>(null)
  if (outcome && outcome !== last?.outcome) setLast({ key, outcome })
  const kept = last && (last.key === key || last.outcome.state === "ready") ? last.outcome : null
  const retry = useCallback(() => {
    if (key) drop(key)
    setLast(null)
    setNonce((n) => n + 1)
  }, [key])
  return { outcome: outcome ?? kept, retry }
}

/** The width a block is laid out at, for "Tap to zoom". */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function SourceCode({ input }: { input: RichInput }) {
  return (
    <CodeBlock>
      {createElement("code", { className: `language-${input.lang}` }, input.source)}
    </CodeBlock>
  )
}

/** The source behind a picture, folded away (no language class: it is not a code block of the chat). */
function SourceDetails({ input, open, onToggle }: { input: RichInput; open: boolean; onToggle(open: boolean): void }) {
  return (
    <details className="rich-src" open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Source</summary>
      <pre className="rich-source">
        <code>{input.source}</code>
      </pre>
    </details>
  )
}

function Picturing({ render, input, readOnly, style }: { render: StaticRender; input: RichInput; readOnly: boolean; style?: CSSProperties }) {
  // Read-only views never mount agent SVG live: an <img> can't run, fetch or overlay (decision 9).
  if (readOnly && input.kind === "svg") return <ImgPicture render={render} style={style} />
  return <Picture render={render} style={style} />
}

// ---------------------------------------------------------------- the chat block

/** `final` is part of the contract's signature; the slot only mounts a block once it is closed or final. */
export function RichBlock({ input, closed = true, readOnly, code }: { input: RichInput; final: boolean; closed?: boolean; readOnly: boolean; code?: ReactNode }) {
  const scheme = useResolvedScheme()
  const panel = usePanel()
  const load = loadRenderer(input.kind)
  const mod = useLazy(load ?? missingRenderer)
  const renderer = mod.module?.default ?? null
  // Big Mermaid graphs block the page while they lay out: the chat shows the source, Open draws it in the panel.
  const tooLarge = input.source.length > KINDS[input.kind].maxBytes || (input.kind === "mermaid" && mermaidTooLargeForChat(input.source))
  const { outcome, retry } = useOutcome(tooLarge ? null : renderer, input, scheme, "chat", !closed)
  const [source, setSource] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const [clipRef, clipWidth] = useWidth<HTMLDivElement>()
  const fallback = code ?? <SourceCode input={input} />
  const kind = input.kind
  const noun = KINDS[kind].noun

  const open = () => {
    if (!readOnly && panel) panel.openBlock(outcome?.state === "ready" ? { ...input, source: outcome.source } : input)
    else setLightbox(true)
  }

  if (tooLarge)
    return (
      <figure className="rich" data-rich-kind={kind} data-rich-state="source">
        {fallback}
        <p className="rich-note">
          {note(input, "too-large")}{" "}
          <button type="button" className="rich-link" onClick={open}>
            Open
          </button>
        </p>
        <Lightbox open={lightbox} onClose={() => setLightbox(false)} label={KINDS[kind].label}>
          <RichView input={input} />
        </Lightbox>
      </figure>
    )
  if (mod.failed)
    return (
      <figure className="rich" data-rich-kind={kind} data-rich-state="error">
        {fallback}
        <p className="rich-note">
          {note(input, "load")}{" "}
          <button type="button" className="rich-link" onClick={mod.retry}>
            Retry
          </button>{" "}
          <button type="button" className="rich-link" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      </figure>
    )
  if (!outcome) {
    if (readOnly)
      return (
        <figure className="rich" data-rich-kind={kind} data-rich-state="loading" aria-busy="true">
          {fallback}
        </figure>
      )
    return <RichSkeleton kind={kind} state="loading" busy />
  }
  if (outcome.state === "source")
    return (
      <figure className="rich" data-rich-kind={kind} data-rich-state="source">
        {fallback}
        <p className="rich-note">
          {SOURCE_NOTES.has(outcome.error.code) ? note(input, outcome.error.code === "schema" ? "parse" : outcome.error.code) : outcome.error.message}
          {DETAIL_NOTES.has(outcome.error.code) && outcome.error.message && <span className="rich-err">{outcome.error.message}</span>}
        </p>
      </figure>
    )
  if (outcome.state === "error")
    return (
      <figure className="rich" data-rich-kind={kind} data-rich-state="error">
        {fallback}
        <p className="rich-note">
          {note(input, outcome.error.code)}{" "}
          <button type="button" className="rich-link" onClick={retry}>
            Retry
          </button>
        </p>
      </figure>
    )

  const r = outcome.render
  const paper = !!renderer?.paper && scheme === "dark"
  const column = clipWidth || 680
  const shown = Math.min(r.width, column)
  const tall = (r.height * shown) / Math.max(1, r.width) > CHAT_MAX_HEIGHT
  const zoomHint = r.width > column * 1.6 ? "Tap to zoom" : undefined
  return (
    <figure className="rich group/rich" data-rich-kind={kind} data-rich-state="ready" data-rich-repaired={outcome.repaired}>
      <Toolbar input={{ ...input, source: outcome.source }} caption={zoomHint} onOpen={open} onSource={() => setSource((v) => !v)} sourceOpen={source} />
      <div ref={clipRef} className={`rich-clip ${paper ? "rich-paper" : ""}`} onClick={open} title={`Open the ${noun}`}>
        <Picturing render={r} input={input} readOnly={readOnly} />
        {tall && <div className="rich-fade" aria-hidden />}
      </div>
      <SourceDetails input={{ ...input, source: outcome.source }} open={source} onToggle={setSource} />
      {lightbox && (
        <Lightbox open={lightbox} onClose={() => setLightbox(false)} label={KINDS[kind].label}>
          <RichView input={input} />
        </Lightbox>
      )}
    </figure>
  )
}

const missingRenderer = (): Promise<RendererModule> => Promise.reject(new Error("no renderer for this kind"))

// ---------------------------------------------------------------- the panel view

type Zoom = "fit" | number

/** A block at full size (the panel, the lightbox): natural size, its own scrolling, Fit · 100% · 200%, Ctrl/⌘+wheel. */
export function RichView({ input }: { input: RichInput }) {
  const scheme = useResolvedScheme()
  const readOnly = !!useReadOnly()
  const load = loadRenderer(input.kind)
  const mod = useLazy(load ?? missingRenderer)
  const renderer = mod.module?.default ?? null
  const tooLarge = input.source.length > KINDS[input.kind].maxBytes * 4
  const { outcome, retry } = useOutcome(tooLarge ? null : renderer, input, scheme, "panel", false)
  const [zoom, setZoom] = useState<Zoom>("fit")
  const [copied, setCopied] = useState(false)
  const kind = input.kind

  if (tooLarge || mod.failed || (outcome && outcome.state !== "ready"))
    return (
      <figure className="rich rich-view" data-rich-kind={kind} data-rich-state={mod.failed || outcome?.state === "error" ? "error" : "source"}>
        <SourceCode input={input} />
        <p className="rich-note">
          {tooLarge ? note(input, "too-large") : mod.failed ? note(input, "load") : outcome && outcome.state !== "ready" ? (outcome.error.code === "parse" ? note(input, "parse") : note(input, outcome.error.code)) : null}
          {outcome?.state === "error" && (
            <>
              {" "}
              <button type="button" className="rich-link" onClick={retry}>
                Retry
              </button>
            </>
          )}
        </p>
      </figure>
    )
  if (!outcome) return <RichSkeleton kind={kind} state="loading" busy />

  const r = outcome.render
  const paper = !!renderer?.paper && scheme === "dark"
  const style: CSSProperties = zoom === "fit" ? { maxWidth: "100%" } : { width: Math.round(r.width * zoom), maxWidth: "none" }
  const z = (v: Zoom, label: string) => (
    <button type="button" aria-pressed={zoom === v} onClick={() => setZoom(v)} className={`rounded-md px-2.5 py-1 text-[12px] transition pointer-coarse:min-h-11 pointer-coarse:px-3 ${zoom === v ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>
      {label}
    </button>
  )
  return (
    <figure className="rich rich-view" data-rich-kind={kind} data-rich-state="ready" data-rich-repaired={outcome.repaired}>
      <div className="rich-bar">
        <span className="rich-kind">{KINDS[kind].label}</span>
        <span className="flex-1" />
        {z("fit", "Fit")}
        {z(1, "100%")}
        {z(2, "200%")}
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(outcome.source).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
          className="rounded-md px-2.5 py-1 text-[12px] text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:min-h-11 pointer-coarse:px-3"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div
        className="rich-stage"
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return
          e.preventDefault()
          const cur = zoom === "fit" ? 1 : zoom
          setZoom(Math.min(4, Math.max(0.25, cur * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
        }}
      >
        <div className={`rich-clip ${paper ? "rich-paper" : ""}`} style={zoom === "fit" ? undefined : { width: "max-content" }}>
          <Picturing render={r} input={input} readOnly={readOnly} style={style} />
        </div>
      </div>
      <SourceDetails input={{ ...input, source: outcome.source }} open={false} onToggle={() => {}} />
    </figure>
  )
}

// ---------------------------------------------------------------- the HTML export

type Statics = Map<string, StaticRender | null>

export const exportKey = (input: Pick<RichInput, "kind" | "source">) => hash(`${input.kind}\n${input.source}`)

export function RichCollect({ into, children }: { into: ExportItems; children?: ReactNode }) {
  return <ExportContext.Provider value={{ mode: "collect", items: into }}>{children}</ExportContext.Provider>
}

export function RichExport({ statics, children }: { statics: Statics; children?: ReactNode }) {
  return <ExportContext.Provider value={{ mode: "export", statics: statics as Map<string, unknown> }}>{children}</ExportContext.Provider>
}

/** One block in the export: the prerendered picture on a paper card, its source under it; the code block when it has none. */
export function ExportBlock({ input, code }: { input: RichInput; code: ReactNode }) {
  const ctx = useExportStatics()
  const r = ctx?.get(exportKey(input))
  if (!r) return <>{code}</>
  return (
    <figure className="rich" data-rich-kind={input.kind} data-rich-state="ready">
      <div className="rich-paper rich-clip">{input.kind === "svg" ? <ImgPicture render={r} /> : <ExportPicture render={r} />}</div>
      <details className="rich-src rich-src-export">
        <summary>Source</summary>
        <pre className="rich-source">
          <code>{input.source}</code>
        </pre>
      </details>
    </figure>
  )
}

function useExportStatics(): Statics | null {
  const v = useContext(ExportContext)
  return v?.mode === "export" ? (v.statics as Statics) : null
}

/** Static pictures for every collected block, always in the light theme (the export's card is light). */
export async function prerenderForExport(items: ExportItems, { timeoutMs }: { timeoutMs: number }): Promise<Statics> {
  const out: Statics = new Map()
  if (items.tex.length) await ensure(loadKatex).catch(() => null)
  const deadline = Date.now() + timeoutMs
  for (const input of items.blocks) {
    const load = loadRenderer(input.kind)
    if (!load) continue
    try {
      const mod = await ensure(load)
      const left = deadline - Date.now()
      if (left <= 0) break
      const o = await Promise.race([produce(mod.default, input, LIGHT_TOKENS, "export", false), new Promise<null>((r) => setTimeout(() => r(null), left))])
      out.set(exportKey(input), o && o.state === "ready" ? o.render : null)
    } catch {
      out.set(exportKey(input), null)
    }
  }
  return out
}
