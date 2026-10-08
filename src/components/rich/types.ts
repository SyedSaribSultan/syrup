import type { ComponentType } from "react"
import type { RichKind } from "@/lib/rich/kinds"

/** Types only (docs/RENDERING.md §2.15): shared by the main-chunk stub, the lazy core and the renderers. */

export type RichOrigin =
  | { from: "fence"; sessionID: string | null; messageID: string | null; partID: string | null; endedAt: number | null }
  | { from: "file"; rel: string }
  | { from: "tool"; sessionID: string; messageID: string; partID: string; tool: string }
  | { from: "block" }

export interface RichInput {
  kind: RichKind
  lang: string
  source: string
  title?: string
  origin: RichOrigin
}

export type RichSurface = "chat" | "panel" | "export"
export type RichState = "pending" | "loading" | "ready" | "source" | "error"

export interface RichError {
  code: "parse" | "schema" | "empty" | "remote" | "cut-off" | "too-large" | "render" | "timeout" | "load"
  message: string
  line?: number
  repairable: boolean
}

export type Validated<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: RichError }

export interface ThemeTokens {
  scheme: "light" | "dark"
  font: string
  mono: string
  ink: string
  ink2: string
  muted: string
  line: string
  line2: string
  surface: string
  surface2: string
  accent: string
  accentSoft: string
  ok: string
  warn: string
  err: string
  series: string[]
}

export interface RenderCtx {
  surface: RichSurface
  tokens: ThemeTokens
  width: number
  signal: AbortSignal
}

/** A finished picture: sanitized markup for a shadow root (or an <img> in read-only views), its natural size and its spoken label. */
export interface StaticRender {
  markup: string
  css?: string
  width: number
  height: number
  label: string
}

export interface Renderer<T = unknown> {
  kind: RichKind
  /** "mermaid@11.17.2/r1": part of every cache key. */
  version: string
  validate(input: RichInput, signal: AbortSignal): Promise<Validated<T>>
  /** Deterministic candidates; the first valid one wins. */
  autofix?(source: string, error: RichError): string[]
  /** The chat picture (static kinds) and the export (all kinds). */
  toStatic?(value: T, ctx: RenderCtx): Promise<StaticRender>
  /** Pictures that read dark-on-transparent sit on a light paper card in dark mode (agent SVG). */
  paper?: boolean
  /** The panel; the chat too for "interactive" kinds. */
  View?: ComponentType<{ value: T; input: RichInput; ctx: RenderCtx }>
}

/** A renderer module as the loader maps hold it: its value type is its own business. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RendererModule = { default: Renderer<any> }

export type ExportItems = { blocks: RichInput[]; tex: { tex: string; display: boolean }[] }
