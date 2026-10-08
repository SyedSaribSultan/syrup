/**
 * Deterministic repairs for the commonest broken diagrams (docs/RENDERING.md §3.2a). Pure: the core re-validates each
 * candidate and draws the first valid one, marked data-rich-repaired="autofix". A valid diagram gets no candidate.
 */

type Fix = (source: string, type: string) => string

const lines = (s: string, f: (line: string) => string) => s.split("\n").map(f).join("\n")

/** The diagram type: the first word of the first line that isn't blank, a comment or a directive. */
export function mermaidType(source: string): string {
  for (const raw of source.split("\n")) {
    const l = raw.trim()
    if (!l || l.startsWith("%%") || l === "---") continue
    return l.split(/[\s;]/)[0].toLowerCase()
  }
  return ""
}

const quote = (inner: string) => `"${inner.trim().replace(/"/g, "#quot;")}"`

/** Flowcharts: a label holding ()[]{}| inside its shape's brackets gets double quotes (`A[Cart (guest)]` → `A["Cart (guest)"]`). */
const quoteLabels: Fix = (s, type) => {
  if (type !== "flowchart" && type !== "graph") return s
  return lines(s, (l) =>
    l
      .replace(/\b([A-Za-z0-9_]+)\[([^[\]"\n]*)\]/g, (all, id: string, inner: string) => (/[(){}|]/.test(inner) && !/^[(/\\]/.test(inner) ? `${id}[${quote(inner)}]` : all))
      .replace(/\b([A-Za-z0-9_]+)\{([^{}"\n]*)\}/g, (all, id: string, inner: string) => (/[()[\]|]/.test(inner) ? `${id}{${quote(inner)}}` : all))
      .replace(/\b([A-Za-z0-9_]+)\(([^()"\n]*)\)/g, (all, id: string, inner: string) => (/[[\]{}|]/.test(inner) && !/^[[/\\]/.test(inner) ? `${id}(${quote(inner)})` : all)),
  )
}

/** Typographic quotes become plain ones. */
const smartQuotes: Fix = (s) => s.replace(/[“”„″]/g, '"').replace(/[‘’]/g, "'")

/** A fence line left inside the diagram (a nested or doubled ``` ). */
const strayFences: Fix = (s) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(`{3,}|~{3,})[\w-]*\s*$/.test(l))
    .join("\n")

const ARROW = "(?:-->>|->>|-->|->|--x|-x|--\\)|-\\))[+-]?"

/** Sequence diagrams: no `;` at line ends, and a message without its `:` gets one (`A->>B hello` → `A->>B: hello`). */
const sequenceMessages: Fix = (s, type) => {
  if (type !== "sequencediagram") return s
  const msg = new RegExp(`^(\\s*[A-Za-z0-9_]+\\s*${ARROW}\\s*[A-Za-z0-9_]+)\\s+([^:\\s].*)$`)
  return lines(s, (l) => l.replace(/;\s*$/, "").replace(msg, "$1: $2"))
}

/** State diagrams draw transitions with `-->`, not `->`. */
const stateArrows: Fix = (s, type) => {
  if (!type.startsWith("statediagram")) return s
  return lines(s, (l) => l.replace(/(?<![-=<])->(?!>)/g, "-->"))
}

/** Pie slices need `:` between the label and the value (`"Dogs" 386` → `"Dogs" : 386`). */
const pieColons: Fix = (s, type) => {
  if (type !== "pie") return s
  return lines(s, (l) => l.replace(/^(\s*"[^"]*")\s+(-?\d[\d.]*)\s*$/, "$1 : $2"))
}

const FIXES: Fix[] = [smartQuotes, strayFences, quoteLabels, sequenceMessages, stateArrows, pieColons]

/** At most 5 candidates: every fix that applies, together first, then each alone. */
export function mermaidFixes(source: string): string[] {
  const type = mermaidType(source)
  const singles: string[] = []
  let all = source
  for (const fix of FIXES) {
    const one = fix(source, type)
    if (one !== source) singles.push(one)
    all = fix(all, mermaidType(all))
  }
  const out: string[] = []
  for (const c of [all, ...singles]) if (c !== source && !out.includes(c)) out.push(c)
  return out.slice(0, 5)
}
