import type { Options } from "react-markdown"
import remarkMath from "remark-math"

/**
 * The math parser, a lazy chunk (docs/RENDERING.md §2.5): loads the first time a text holds `$`, `\(` or `\[`.
 * remark-math, then Pandoc's dollar rule, so prices and shell variables stay prose; and a normalizer that turns the
 * `\(…\)` and `\[…\]` weak models write into dollars before Markdown's escaping destroys them.
 */

type Pos = { start: { offset?: number }; end: { offset?: number } }
type Node = { type: string; value?: string; position?: Pos; children?: Node[] }

/**
 * Runs after remark-math. Pandoc's rule for single-dollar math: the opening `$` is followed by a non-space, the closing
 * `$` is preceded by a non-space and not followed by a digit. Anything else goes back to the text it was, so
 * "$5 and $10" and "$PATH and $HOME" stay prose. `$$…$$` is always math.
 */
export function remarkMathGuard() {
  return (tree: Node, file: { value: unknown }) => {
    const src = String(file.value)
    const walk = (parent: Node) => {
      const kids = parent.children
      if (!kids) return
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i]
        if (n.type === "inlineMath") {
          const s = n.position?.start.offset
          const e = n.position?.end.offset
          if (s == null || e == null) continue
          const raw = src.slice(s, e)
          // Read the source, not the node's value: remark-math trims a space of padding ("$ 5 and $" has value "5 and").
          // Pandoc's rule, plus: math doesn't run straight into a word or a quote (`"$ref", "b": "$id"` in prose JSON).
          const ok = raw.startsWith("$$") || (/^\$\S/.test(raw) && /\S\$$/.test(raw) && !/^[\w"'`]/.test(src.slice(e, e + 1)))
          if (!ok) kids[i] = { type: "text", value: raw }
        } else walk(n)
      }
    }
    walk(tree)
  }
}

export type PluggableList = NonNullable<Options["remarkPlugins"]>

export const plugins: PluggableList = [remarkMath, remarkMathGuard]

const FENCE = /^ {0,3}(?:>\s?)*(?:[-*+]\s+|\d{1,9}[.)]\s+)*(`{3,}|~{3,})/

/** Prose stretches of `text`, between fenced code blocks and inline code spans. */
function proseParts(text: string): { prose: boolean; s: string }[] {
  const out: { prose: boolean; s: string }[] = []
  const lines = text.split(/(?<=\n)/)
  let fence: string | null = null
  let buf = ""
  const flush = (prose: boolean) => {
    if (buf) out.push({ prose, s: buf })
    buf = ""
  }
  for (const line of lines) {
    const m = FENCE.exec(line)
    if (fence) {
      buf += line
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(line.indexOf(m[1]) + m[1].length).trim()) {
        flush(false)
        fence = null
      }
    } else if (m) {
      flush(true)
      fence = m[1]
      buf = line
    } else buf += line
  }
  flush(!fence)
  // Inline code spans inside prose: a run of backticks up to the same run.
  const split: { prose: boolean; s: string }[] = []
  for (const p of out) {
    if (!p.prose) {
      split.push(p)
      continue
    }
    // Inline code, and math already in dollars ($$…$$, $…$ on one line): TeX there keeps its own \[ and \\[4pt].
    let last = 0
    for (const m of p.s.matchAll(/(`+)[\s\S]*?(?<!`)\1(?!`)|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g)) {
      if (m.index > last) split.push({ prose: true, s: p.s.slice(last, m.index) })
      split.push({ prose: false, s: m[0] })
      last = m.index + m[0].length
    }
    if (last < p.s.length) split.push({ prose: true, s: p.s.slice(last) })
  }
  return split
}

/**
 * `\(x\)` → `$x$` (one line) and `\[ … \]` → `$$ … $$` (may span lines), outside fenced code, inline code and math
 * already in dollars. Not an escaped backslash (`\\[4pt]` is a TeX row break), and not Markdown's escaped brackets of a
 * link (`\[x\](url)`).
 */
export function normalize(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text
  return proseParts(text)
    .map((p) =>
      !p.prose
        ? p.s
        : p.s
            .replace(/(?<!\\)\\\[((?:(?!\\\])[\s\S])+?)(?<!\\)\\\](?!\()/g, (all, body: string) => (body.trim() ? `$$${body}$$` : all))
            .replace(/(?<!\\)\\\(([^\n]+?)(?<!\\)\\\)/g, (all, body: string) => (body.trim() ? `$${body.trim()}$` : all)),
    )
    .join("")
}
