"use client"

import { Component, createContext, useContext, useEffect, type ReactNode } from "react"
import { fenceState, trimPartialCloser } from "@/lib/rich/fence"
import { fenceKind, KINDS, type RichKind } from "@/lib/rich/kinds"
import { ensure, loadCore, loadKatex, useLazy } from "@/lib/rich/lazy"
import { enabled, loadRenderer } from "@/lib/rich/loaders"
import { useReadOnly } from "../read-only"
import type { ExportItems, RichInput, RichOrigin } from "./types"

/**
 * The main-chunk side of rich output (docs/RENDERING.md §2.3, §2.4): decides, per code block, whether it is a picture
 * and whether it may be drawn yet, and hands it to the lazy core. Nothing here parses a diagram or loads a library.
 */

export type FenceOrigin = Extract<RichOrigin, { from: "fence" }>

const NO_ORIGIN: FenceOrigin = { from: "fence", sessionID: null, messageID: null, partID: null, endedAt: null }

/** What the Markdown around a block knows: the exact source it parsed, whether that text is final, where it came from. */
export const MdContext = createContext<{ source: string; final: boolean; origin: FenceOrigin | null } | null>(null)

/** The HTML export's two passes (§2.9): collect the inputs, then embed the prerendered pictures. */
export type ExportMode = { mode: "collect"; items: ExportItems } | { mode: "export"; statics: Map<string, unknown> }
export const ExportContext = createContext<ExportMode | null>(null)

type HastNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }

const classes = (n: HastNode | undefined): string[] => {
  const c = n?.properties?.className
  return Array.isArray(c) ? c.map(String) : typeof c === "string" ? c.split(/\s+/) : []
}

function textOf(n: HastNode | undefined): string {
  if (!n) return ""
  if (n.type === "text") return n.value ?? ""
  return (n.children ?? []).map(textOf).join("")
}

const NOUN_GERUND: Partial<Record<RichKind, string>> = { svg: "Drawing a picture", "vega-lite": "Drawing a chart", table: "Building a table", markmap: "Drawing a mind map" }

/** A kind-shaped placeholder of the kind's height. `busy`: something is loading (the harness and screen readers wait). */
export function RichSkeleton({ kind, state, caption, busy, children }: { kind: RichKind; state: "pending" | "loading"; caption?: string; busy?: boolean; children?: ReactNode }) {
  const info = KINDS[kind]
  const words = NOUN_GERUND[kind] ?? "Drawing a diagram"
  return (
    <figure className="rich" data-rich-kind={kind} data-rich-state={state} aria-busy={busy || undefined}>
      <div className="rich-skel" data-shape={info.skeleton} aria-hidden="true" style={{ minHeight: info.minHeight }}>
        <i className="skel" />
        <i className="skel" />
        <i className="skel" />
        <i className="skel" />
      </div>
      <span className="sr-only">{words}</span>
      {caption && <p className="rich-cap">{caption}</p>}
      {children}
    </figure>
  )
}

/** A renderer bug never takes the message with it: the block falls back to its code. */
export class RichBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** An open fence: a skeleton and the raw source in a closed <details>. Its renderer and the core load at once. */
function Pending({ kind, raw }: { kind: RichKind; raw: string }) {
  useEffect(() => {
    const load = loadRenderer(kind)
    if (load) void ensure(load).catch(() => {})
    void ensure(loadCore).catch(() => {})
  }, [kind])
  const text = raw.replace(/\n$/, "")
  const lines = text ? text.split("\n").length : 0
  const words = NOUN_GERUND[kind] ?? "Drawing a diagram"
  return (
    <RichSkeleton kind={kind} state="pending" caption={`${words} · ${lines} line${lines === 1 ? "" : "s"}`}>
      <details className="rich-src">
        <summary>Source</summary>
        <pre className="rich-source">
          <code>{raw}</code>
        </pre>
      </details>
    </RichSkeleton>
  )
}

/** A closed (or final) fence of a drawable kind: the core draws it; until the core has loaded, a skeleton (or, read-only, the code). */
function RichFence({ input, final, closed, code }: { input: RichInput; final: boolean; closed: boolean; code: ReactNode }) {
  const ro = !!useReadOnly()
  const exp = useContext(ExportContext)
  const core = useLazy(loadCore)
  const C = core.module
  if (exp?.mode === "collect") {
    if (!exp.items.blocks.some((b) => b.kind === input.kind && b.source === input.source)) exp.items.blocks.push(input)
    return code
  }
  if (exp?.mode === "export") return C ? <C.ExportBlock input={input} code={code} /> : code
  if (C)
    return (
      <RichBoundary fallback={code}>
        <C.RichBlock input={input} final={final} closed={closed} readOnly={ro} code={code} />
      </RichBoundary>
    )
  if (core.failed)
    return (
      <figure className="rich" data-rich-kind={input.kind} data-rich-state="error">
        {code}
        <p className="rich-note">
          Couldn&apos;t load the diagram viewer.{" "}
          <button type="button" className="rich-link" onClick={core.retry}>
            Retry
          </button>{" "}
          <button type="button" className="rich-link" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      </figure>
    )
  // Read-only pages show the code until the core arrives (the server's HTML, no-JS readers): one swap, no skeleton.
  if (ro) return code
  return <RichSkeleton kind={input.kind} state="loading" busy />
}

/** Display math (`$$…$$`): the TeX in muted mono while it is open, KaTeX once it is closed or final. */
function DisplayMath({ tex, ready }: { tex: string; ready: boolean }) {
  if (!ready)
    return (
      <pre className="rich-tex-open" data-rich-state="pending">
        <code>{tex}</code>
      </pre>
    )
  return <TexSlot tex={tex} display />
}

/** One formula, drawn by the lazy KaTeX chunk; its TeX shows meanwhile. */
export function TexSlot({ tex, display }: { tex: string; display: boolean }) {
  const exp = useContext(ExportContext)
  const k = useLazy(loadKatex)
  const T = k.module?.Tex
  if (exp?.mode === "collect") exp.items.tex.push({ tex, display })
  const raw = display ? <pre className="rich-tex-open">{tex}</pre> : <code>{tex}</code>
  // A formula KaTeX can't take never takes the message, or the page, with it.
  if (T)
    return (
      <RichBoundary fallback={raw}>
        <T tex={tex} display={display} output={exp ? "mathml" : undefined} />
      </RichBoundary>
    )
  if (k.failed) return raw
  if (display)
    return (
      <div className="rich-tex-display" data-rich-state="loading" aria-busy="true">
        <code className="rich-tex-src">{tex}</code>
      </div>
    )
  return (
    <span className="rich-tex" data-rich-state="loading" aria-busy="true">
      <code className="rich-tex-src">{tex}</code>
    </span>
  )
}

/** Inline math from remark-math. `$$…$$` written inline renders in the line, at display size. */
export function InlineMath({ node, children }: { node?: HastNode; children: ReactNode }) {
  const md = useContext(MdContext)
  const tex = typeof children === "string" ? children : textOf(node)
  const start = node?.position?.start.offset
  const wide = md && start != null && md.source.startsWith("$$", start)
  return <TexSlot tex={wide ? `\\displaystyle ${tex}` : tex} display={false} />
}

/**
 * The `pre` override (§2.4). `children` is today's code block, rendered whenever the block isn't drawn: not a rich
 * kind, a kind not enabled yet, the info line still typing, or a block that must stay code.
 */
export function FenceSlot({ node, children }: { node?: HastNode; children: ReactNode }) {
  const md = useContext(MdContext)
  const code = node?.children?.find((c) => c.type === "element" && c.tagName === "code")
  const cls = classes(code)
  const start = node?.position?.start.offset
  const end = node?.position?.end.offset
  const raw = md && start != null && end != null ? md.source.slice(start, end) : null
  const st = raw === null ? null : fenceState(raw)
  const body = textOf(code)
  const lang = cls.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? ""
  const final = md?.final ?? true
  const ready = !!st && (st.closed || final)
  const kind = st && st.infoDone && lang && !cls.includes("math-display") ? fenceKind(lang, ready ? body : undefined) : null
  const drawable = kind !== null && enabled(kind) && KINDS[kind].chat !== "code" && KINDS[kind].chat !== "none"
  const origin = md?.origin ?? null
  const source = st && !st.closed ? trimPartialCloser(body, st.marker) : body
  const input: RichInput | null = drawable && kind ? { kind, lang, source: source.replace(/\n$/, ""), origin: origin ?? NO_ORIGIN } : null
  if (cls.includes("math-display")) {
    if (!st) return <TexSlot tex={body} display />
    return <DisplayMath tex={st.closed ? body : trimPartialCloser(body, "$")} ready={ready} />
  }
  if (!st || !input) return children
  if (!ready) return <Pending kind={input.kind} raw={body} />
  return <RichFence input={input} final={final} closed={st.closed} code={children} />
}
