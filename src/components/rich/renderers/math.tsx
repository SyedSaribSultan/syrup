import katex from "katex"
import "katex/dist/katex.min.css"

/**
 * KaTeX (docs/RENDERING.md §2.5): a lazy chunk with its stylesheet. Untrusted TeX: trust off, expansion and sizes
 * capped, errors drawn in place instead of thrown. The app shows HTML plus MathML (screen readers read the MathML);
 * the HTML export takes MathML only, which needs no fonts and no CSS.
 *
 * Some TeX is shown as code instead of typeset: anything KaTeX throws on (deep nesting overflows its stack with a
 * RangeError, which no throwOnError option catches), very deep or very long formulas, and the commands that draw
 * outside a formula's own box (negative kerns and skips, \llap/\rlap and their math forms), which could paint text
 * over the conversation.
 */

type Output = "htmlAndMathml" | "mathml"

const cache = new Map<string, string>()

const MAX_TEX = 4000
const MAX_DEPTH = 40
/** Moves drawn outside the formula's box: negative \kern, \mkern, \hskip, \mskip, \hspace, and the overlapping boxes. */
const ESCAPES_BOX = /\\(?:m?kern|[hm]skip|hspace\*?)\s*\{?\s*-|\\(?:math)?[lrc]lap(?![a-zA-Z])/

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

function depth(tex: string): number {
  let d = 0
  let max = 0
  for (const ch of tex) {
    if (ch === "{") max = Math.max(max, ++d)
    else if (ch === "}") d--
  }
  return max
}

/** Why this TeX is shown as code, or null when KaTeX may typeset it. */
export function refuseTex(tex: string): string | null {
  if (tex.length > MAX_TEX) return "too long"
  if (depth(tex) > MAX_DEPTH) return "nested too deeply"
  if (ESCAPES_BOX.test(tex)) return "draws outside its box"
  return null
}

const asCode = (tex: string, display: boolean) => `<code class="rich-tex-raw${display ? " rich-tex-raw-display" : ""}">${escapeHtml(tex)}</code>`

export function texToHtml(tex: string, display: boolean, output: Output = "htmlAndMathml"): string {
  const key = `${output}|${display ? "D" : "I"}|${tex}`
  let html = cache.get(key)
  if (html === undefined) {
    if (refuseTex(tex)) html = asCode(tex, display)
    else {
      try {
        html = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: "ignore", maxSize: 10, maxExpand: 1000, output })
      } catch {
        html = asCode(tex, display)
      }
    }
    if (cache.size > 500) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, html)
  }
  return html
}

/** One formula: `display` is a block of its own (scrolls sideways when wide), otherwise it sits in the line. */
export function Tex({ tex, display, output = "htmlAndMathml" }: { tex: string; display: boolean; output?: Output }) {
  const html = texToHtml(tex, display, output)
  if (display) return <div className="rich-tex-display" data-rich-state="ready" dangerouslySetInnerHTML={{ __html: html }} />
  return <span className="rich-tex" data-rich-state="ready" dangerouslySetInnerHTML={{ __html: html }} />
}
