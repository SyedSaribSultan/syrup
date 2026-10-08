/**
 * Mermaid draws into the live page before our sanitizer sees its SVG (mermaid.render measures text in
 * document.body), so a source that asks the browser for another origin would be fetched from syrup's origin while it
 * draws: the img shape (`A@{ img: "https://…" }`), and CSS from `style`, `classDef` and `linkStyle` with url(),
 * image-set(), src() or @import (border-image, list-style-image, mask-image… in flowcharts, state, class and block
 * diagrams). Such a source is never handed to Mermaid: it shows as source with a note (docs/RENDERING.md §2.12).
 * The check reads the source twice, as written and with CSS escapes decoded, so `\75rl(` is url( too.
 */

/** CSS escapes decoded: `\75 ` and `\000075` are "u", `\r` is "r". */
export function cssUnescape(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_, hex: string | undefined, ch: string | undefined) => {
    if (hex === undefined) return ch ?? ""
    const n = parseInt(hex, 16)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�"
  })
}

const FETCHES = [
  /url\s*\(/i,
  /\bsrc\s*\(/i,
  /image-set\s*\(/i,
  /@import/i,
  /@font-face/i,
  // The img shape and its JSON-ish spelling ("img": "…").
  /\bimg\b["']?\s*:/i,
]

/** Why this Mermaid source must not be drawn (it would fetch while Mermaid lays it out), or null. */
export function mermaidFetchRisk(source: string): string | null {
  const decoded = cssUnescape(source)
  for (const re of FETCHES) {
    const m = re.exec(source) ?? re.exec(decoded)
    if (m) return m[0].replace(/\s+/g, "")
  }
  return null
}

/**
 * Past this many links (or lines) a diagram blocks the page for half a second or more while Mermaid lays it out
 * (measured: 499 links, 0.5–0.9 s on a desktop). The chat shows its source with "Too large to draw here." and Open,
 * which draws it in the panel on demand.
 */
export const MERMAID_CHAT_MAX_LINKS = 250
export const MERMAID_CHAT_MAX_LINES = 600

const LINK = /<?(?:-{2,}|={2,}|-\.+-|~{3,})[>xo]?|->>|-->>|-[x)]/g

/** A rough size: how many links the diagram draws and how many lines it has. */
export function mermaidSize(source: string): { links: number; lines: number } {
  let links = 0
  for (const line of source.split("\n")) {
    const l = line.trim()
    if (!l || l.startsWith("%%")) continue
    links += (l.match(LINK) ?? []).length
  }
  return { links, lines: source.split("\n").length }
}

export function mermaidTooLargeForChat(source: string): boolean {
  const { links, lines } = mermaidSize(source)
  return links > MERMAID_CHAT_MAX_LINKS || lines > MERMAID_CHAT_MAX_LINES
}
