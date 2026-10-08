/**
 * What the chat can draw (docs/RENDERING.md §2.2, §2.15). Data only, no imports: this file is in the main chunk, and
 * every surface (fences, Preview files, tool parts, panel blocks) decides its kind here. A kind is drawn only when a
 * loader map has a renderer for it (src/lib/rich/loaders.ts); the others stay code blocks until their round.
 */

export type RichKind = "mermaid" | "svg" | "vega-lite" | "table" | "markmap" | "excalidraw" | "geojson" | "notebook" | "html" | "react"
export type SkeletonShape = "diagram" | "chart" | "table" | "tree"

export interface KindInfo {
  /** "diagram": notes ("This diagram has a syntax error…") and the "Preview · Diagram" tab label. */
  noun: string
  /** The toolbar's kind label. */
  label: string
  skeleton: SkeletonShape
  /** px reserved while pending or loading: near the kind's typical picture height, so a late render jumps little. */
  minHeight: number
  chat: "static" | "interactive" | "code" | "none"
  repairable: boolean
  /** The chat's cap on the source; the panel allows 4×. */
  maxBytes: number
}

const KB = 1024

export const KINDS: Readonly<Record<RichKind, KindInfo>> = {
  mermaid: { noun: "diagram", label: "Diagram", skeleton: "diagram", minHeight: 240, chat: "static", repairable: true, maxBytes: 20 * KB },
  svg: { noun: "picture", label: "SVG", skeleton: "diagram", minHeight: 160, chat: "static", repairable: false, maxBytes: 200 * KB },
  "vega-lite": { noun: "chart", label: "Chart", skeleton: "chart", minHeight: 260, chat: "static", repairable: true, maxBytes: 100 * KB },
  table: { noun: "table", label: "Table", skeleton: "table", minHeight: 200, chat: "interactive", repairable: false, maxBytes: 512 * KB },
  markmap: { noun: "mind map", label: "Mind map", skeleton: "tree", minHeight: 260, chat: "static", repairable: false, maxBytes: 50 * KB },
  excalidraw: { noun: "drawing", label: "Drawing", skeleton: "diagram", minHeight: 320, chat: "none", repairable: false, maxBytes: 2048 * KB },
  geojson: { noun: "map", label: "Map", skeleton: "chart", minHeight: 320, chat: "none", repairable: false, maxBytes: 2048 * KB },
  notebook: { noun: "notebook", label: "Notebook", skeleton: "table", minHeight: 320, chat: "none", repairable: false, maxBytes: 4096 * KB },
  html: { noun: "page", label: "HTML", skeleton: "diagram", minHeight: 320, chat: "code", repairable: false, maxBytes: 512 * KB },
  react: { noun: "component", label: "React", skeleton: "diagram", minHeight: 320, chat: "code", repairable: false, maxBytes: 512 * KB },
}

const FENCE_LANGS: Record<string, RichKind> = {
  mermaid: "mermaid",
  mmd: "mermaid",
  svg: "svg",
  "vega-lite": "vega-lite",
  vegalite: "vega-lite",
  vl: "vega-lite",
  csv: "table",
  tsv: "table",
  markmap: "markmap",
  excalidraw: "excalidraw",
  geojson: "geojson",
  html: "html",
  jsx: "react",
  tsx: "react",
  react: "react",
}

/** A fence's kind from its info string's first word. `body` (only once the fence is closed or final) lets `xml` that is an SVG count. */
export function fenceKind(lang: string, body?: string): RichKind | null {
  const l = lang.trim().toLowerCase()
  const k = FENCE_LANGS[l]
  if (k) return k
  if (body !== undefined && l === "xml" && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(body)) return "svg"
  return null
}

const FILE_SUFFIXES: [string, RichKind][] = [
  [".vega-lite.json", "vega-lite"],
  [".vl.json", "vega-lite"],
  [".markmap.md", "markmap"],
  [".mm.md", "markmap"],
  [".mermaid", "mermaid"],
  [".mmd", "mermaid"],
  [".svg", "svg"],
  [".csv", "table"],
  [".tsv", "table"],
  [".excalidraw", "excalidraw"],
  [".geojson", "geojson"],
  [".ipynb", "notebook"],
  [".html", "html"],
  [".htm", "html"],
  [".jsx", "react"],
  [".tsx", "react"],
]

/** A workspace file's kind: full-name suffixes first (`chart.vl.json`), then the extension. */
export function fileKind(rel: string): RichKind | null {
  const name = rel.toLowerCase()
  for (const [suffix, kind] of FILE_SUFFIXES) if (name.endsWith(suffix)) return kind
  return null
}

const TOOL_KINDS: Record<string, RichKind | "form"> = {
  syrup_show_chart: "vega-lite",
  syrup_show_table: "table",
  syrup_show_diagram: "mermaid",
  syrup_ask_form: "form",
}

/** Round 7's structured tools, as OpenCode names them. */
export function toolKind(tool: string): RichKind | "form" | null {
  return TOOL_KINDS[tool] ?? null
}
