import mermaid, { type MermaidConfig } from "mermaid"
import { mermaidFixes } from "@/lib/rich/autofix"
import { mermaidFetchRisk } from "@/lib/rich/mermaid-guard"
import { MAX_SVG_BYTES, sanitizeSvg } from "../sanitize"
import { schedule } from "../scheduler"
import type { Renderer, RichError, ThemeTokens } from "../types"

/**
 * ```mermaid fences (docs/RENDERING.md §3.2a, §2.12). Mermaid 11 in strict mode, themed from the app's tokens; every
 * use of its global singleton goes through runWithMermaid, so a foreign initialize (the Excalidraw converter, Round 6)
 * can't leave its config behind: the next render initializes again. Labels are SVG text (htmlLabels off), so its
 * output passes our own sanitizer with the agent-SVG profile, <foreignObject> forbidden, then a shadow root inside
 * the clip.
 */

type Mermaid = typeof mermaid

const SECURE = ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "dompurifyConfig", "themeCSS", "themeVariables", "theme", "darkMode", "fontFamily", "htmlLabels", "look", "layout"]

export function mermaidConfig(t: ThemeTokens): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    logLevel: "fatal",
    maxTextSize: 80_000,
    maxEdges: 500,
    secure: SECURE,
    theme: "base",
    darkMode: t.scheme === "dark",
    fontFamily: t.font,
    // Labels as SVG text, not HTML in <foreignObject>: nothing but SVG reaches the sanitizer.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // Journey draws task text in <foreignObject> by default ("fo"), which the sanitizer removes: SVG text instead.
    journey: { textPlacement: "tspan" },
    themeVariables: {
      darkMode: t.scheme === "dark",
      fontFamily: t.font,
      fontSize: "14px",
      background: t.surface,
      primaryColor: t.surface2,
      primaryTextColor: t.ink,
      primaryBorderColor: t.line2,
      lineColor: t.muted,
      secondaryColor: t.accentSoft,
      tertiaryColor: t.surface,
      noteBkgColor: t.accentSoft,
      noteTextColor: t.ink,
      noteBorderColor: t.line2,
      actorBkg: t.surface2,
      actorBorder: t.line2,
      actorTextColor: t.ink,
      signalColor: t.ink2,
      signalTextColor: t.ink,
      labelBoxBkgColor: t.surface2,
      labelTextColor: t.ink,
      edgeLabelBackground: t.surface,
    },
  }
}

/** What Mermaid was last initialized with by this file; null after anyone else used the singleton. */
let initialized: string | null = null

function ensureInit(t: ThemeTokens) {
  const sig = JSON.stringify(t)
  if (initialized === sig) return
  mermaid.initialize(mermaidConfig(t))
  initialized = sig
}

/**
 * The only door to the Mermaid singleton for code outside this file: runs `fn` in the render queue, one at a time,
 * and afterwards marks the config dirty, so the next diagram initializes Mermaid again with the app's theme.
 */
export function runWithMermaid<T>(fn: (m: Mermaid, config: MermaidConfig) => Promise<T>, tokens: ThemeTokens): Promise<T> {
  return schedule(async () => {
    try {
      return await fn(mermaid, mermaidConfig(tokens))
    } finally {
      initialized = null
    }
  })
}

function parseError(err: unknown): RichError {
  const text = err instanceof Error ? err.message : String(err)
  const line = /line (\d+)/i.exec(text)
  // "Parse error on line 2:", the source line, a caret, then what was expected: keep the first and the last.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  const head = lines[0] ?? "Parse error"
  const tail = lines.length > 1 && /^(Expecting|Unexpected|Lexical|Unrecognized)/i.test(lines[lines.length - 1]) ? ` ${lines[lines.length - 1]}` : ""
  return { code: "parse", message: `${head}${tail}`.slice(0, 300), line: line ? Number(line[1]) : undefined, repairable: true }
}

const TYPE_NAMES: Record<string, string> = {
  flowchart: "Flowchart",
  graph: "Flowchart",
  sequencediagram: "Sequence diagram",
  classdiagram: "Class diagram",
  statediagram: "State diagram",
  "statediagram-v2": "State diagram",
  erdiagram: "Entity diagram",
  gantt: "Gantt chart",
  pie: "Pie chart",
  journey: "Journey",
  mindmap: "Mind map",
  timeline: "Timeline",
  gitgraph: "Git graph",
}

let counter = 0

const renderer: Renderer<string> = {
  kind: "mermaid",
  version: "mermaid@11.17.2/r1",
  async validate(input) {
    if (input.source.length > 20 * 1024) return { ok: false, error: { code: "too-large", message: "Too large to draw here.", repairable: false } }
    // Before Mermaid sees it: drawing happens in the live page, so a fetch would leave from syrup's origin.
    const risk = mermaidFetchRisk(input.source)
    if (risk) return { ok: false, error: { code: "remote", message: `It asks the browser to load ${risk}…`, repairable: false } }
    try {
      // parse reads the global config too (maxTextSize, logLevel): never with someone else's.
      if (initialized === null) ensureInit(LIGHT_FOR_PARSE)
      await mermaid.parse(input.source)
      return { ok: true, value: input.source, warnings: [] }
    } catch (err) {
      return { ok: false, error: parseError(err) }
    }
  },
  autofix(source) {
    return mermaidFixes(source)
  },
  async toStatic(source, ctx) {
    ensureInit(ctx.tokens)
    const id = `rich-m${++counter}`
    let svg: string
    try {
      svg = (await mermaid.render(id, source)).svg
    } finally {
      // Mermaid removes its scratch element itself; a failed render may leave it behind.
      document.getElementById(`d${id}`)?.remove()
    }
    const clean = sanitizeSvg(svg, { max: 4 * MAX_SVG_BYTES })
    if (!clean) throw new Error("Mermaid drew nothing")
    const first = source.trim().split(/\s/)[0].toLowerCase()
    const name = TYPE_NAMES[first] ?? "Diagram"
    const labels = Array.from(clean.svg.querySelectorAll(".node text, text.actor, .slice"))
      .map((n) => (n.textContent ?? "").trim())
      .filter(Boolean)
    const unique = [...new Set(labels)]
    const label = unique.length ? `${name}, ${unique.length} labels: ${unique.slice(0, 4).join(", ")}${unique.length > 4 ? "…" : ""}` : name
    return { markup: clean.markup, width: clean.width, height: clean.height, label }
  },
}

/** Parsing needs a config but no theme: the light one stands in until the first render sets the real one. */
const LIGHT_FOR_PARSE: ThemeTokens = { scheme: "light", font: "sans-serif", mono: "monospace", ink: "#000", ink2: "#000", muted: "#000", line: "#000", line2: "#000", surface: "#fff", surface2: "#fff", accent: "#000", accentSoft: "#fff", ok: "#000", warn: "#000", err: "#000", series: [] }

export default renderer
