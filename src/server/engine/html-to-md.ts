/**
 * HTML → Markdown for syrup's `webfetch` (docs/QUALITY.md Q4). OpenCode's own conversion (Turndown without the GFM
 * plugin) flattens every table into one cell per line, so a price lost its row and column labels on the way to the
 * model (the K2 incident's "full board" label). This one keeps tables as GFM tables (colspan and rowspan filled in,
 * so a label repeats on every row it covers), drops page furniture (navigation, menus, cookie banners, forms,
 * scripts, SVG), and keeps links absolute so the model can cite them.
 *
 * Pure and dependency-free: it runs inside syrup's OpenCode plugin (one bundled file, run by OpenCode's Bun) and in
 * scripts/test-plugin.mjs under Node. Lenient by design: a malformed page still gives its text, never an exception
 * that loses the fetch. Linear in the page size (the tokenizer is a single forward scan).
 */

type El = {
  tag: string
  attrs: Record<string, string>
  children: Node[]
  parent: El | null
  depth: number
}
type Node = El | string

const MAX_DEPTH = 200
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "))
/** Elements whose content is never page text: skipped to their closing tag without parsing. */
const RAW_SKIP = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "textarea", "select", "canvas", "video", "audio", "xmp"])
/** Page furniture: dropped with everything inside. `header` and `footer` only outside an article or main. */
const DROP = new Set(["head", "nav", "form", "button", "dialog", "menu", "input", "picture", "img", "map", "label", "fieldset", "datalist", "meter", "progress"])
const DROP_OUTSIDE_CONTENT = new Set(["header", "footer", "aside"])
const DROP_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menu", "menubar", "dialog", "alertdialog", "tablist"])
/** Whole class or id tokens that mark a banner, a pop-up or a share bar (whole tokens only: "entry-header" stays). */
const DROP_TOKEN =
  /^(?:cookies?|cookie-?(?:banner|notice|consent|bar)|consent|gdpr|newsletter|subscribe|social|share|sharing|social-share|share-buttons|breadcrumbs?|skip-link|advert|advertisement|ads?|popup|modal|navbar|site-nav|site-header|site-footer|sidebar|related-posts|comments?)$/i
const BLOCK = new Set(
  "address article aside blockquote body center dd details dialog dir div dl dt fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr html li main nav ol p pre section summary table tbody td tfoot th thead tr ul".split(
    " ",
  ),
)
/** Opening one of these closes an open <p> (HTML's implied end tags, the ones that matter for text). */
const CLOSES_P = new Set("address article aside blockquote details div dl fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hr main menu nav ol p pre section table ul".split(" "))

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  rarr: "→",
  larr: "←",
  laquo: "«",
  raquo: "»",
  shy: "",
  zwj: "",
  zwnj: "",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
}

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m
    }
    const v = ENTITIES[e.toLowerCase()]
    return v === undefined ? m : v
  })
}

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(ATTR)) {
    const k = m[1].toLowerCase()
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "")
  }
  return out
}

/** The page parsed into a tree (lenient: unknown end tags are ignored, open elements close at their parent's end). */
export function parseHtml(html: string): { root: El; title: string } {
  const root: El = {
    tag: "#root",
    attrs: {},
    children: [],
    parent: null,
    depth: 0,
  }
  let cur = root
  let title = ""
  let i = 0
  const n = html.length
  let lower: string | null = null
  const open = (tag: string) => {
    for (let e: El | null = cur; e; e = e.parent) if (e.tag === tag) return e
    return null
  }
  const openAny = (tags: string[]) => {
    for (let e: El | null = cur; e; e = e.parent) if (tags.includes(e.tag)) return e
    return null
  }
  const closeTo = (e: El) => {
    cur = e.parent ?? root
  }
  while (i < n) {
    const lt = html.indexOf("<", i)
    if (lt < 0) {
      cur.children.push(html.slice(i))
      break
    }
    if (lt > i) cur.children.push(html.slice(i, lt))
    i = lt
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i)
      i = end < 0 ? n : end + 1
      continue
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(i, i + 64))
    if (!m) {
      cur.children.push("<")
      i++
      continue
    }
    // The tag's end: the first ">" outside quotes.
    let j = i + m[0].length
    let q = ""
    while (j < n) {
      const c = html[j]
      if (q) {
        if (c === q) q = ""
      } else if (c === '"' || c === "'") q = c
      else if (c === ">") break
      j++
    }
    const tag = m[2].toLowerCase()
    const body = html.slice(i + m[0].length, j)
    i = j + 1
    if (m[1]) {
      const e = open(tag)
      if (e) closeTo(e)
      continue
    }
    if (tag === "title" || RAW_SKIP.has(tag)) {
      lower ??= html.toLowerCase()
      const end = lower.indexOf(`</${tag}`, i)
      const inner = html.slice(i, end < 0 ? n : end)
      if (tag === "title" && !title) title = decodeEntities(inner).replace(/\s+/g, " ").trim()
      const close = end < 0 ? -1 : html.indexOf(">", end)
      i = close < 0 ? n : close + 1
      continue
    }
    // Implied end tags: a new item closes the previous one, a block closes an open paragraph.
    if (tag === "li") {
      const e = open("li")
      if (e && !hasBetween(cur, e, ["ul", "ol"])) closeTo(e)
    } else if (tag === "td" || tag === "th") {
      const e = openAny(["td", "th"])
      if (e && !hasBetween(cur, e, ["table"])) closeTo(e)
    } else if (tag === "tr") {
      const e = open("tr")
      if (e && !hasBetween(cur, e, ["table"])) closeTo(e)
    } else if (tag === "dt" || tag === "dd") {
      const e = openAny(["dt", "dd"])
      if (e && !hasBetween(cur, e, ["dl"])) closeTo(e)
    } else if (tag === "option") {
      const e = open("option")
      if (e) closeTo(e)
    }
    if (CLOSES_P.has(tag)) {
      const p = open("p")
      if (p && !hasBetween(cur, p, ["table", "li", "blockquote", "div", "section", "article"])) closeTo(p)
    }
    const el: El = {
      tag,
      attrs: parseAttrs(body),
      children: [],
      parent: cur,
      depth: cur.depth + 1,
    }
    cur.children.push(el)
    // Past MAX_DEPTH an element's content joins its parent: the converter recurses, and a hostile page nests deep.
    if (!VOID.has(tag) && !body.trimEnd().endsWith("/") && cur.depth < MAX_DEPTH) cur = el
  }
  return { root, title }
}

/** Whether an element named in `tags` sits between `from` (inclusive) and its ancestor `to` (exclusive). */
function hasBetween(from: El, to: El, tags: string[]): boolean {
  for (let e: El | null = from; e && e !== to; e = e.parent) if (tags.includes(e.tag)) return true
  return false
}

function dropped(el: El, inContent: boolean): boolean {
  if (DROP.has(el.tag)) return true
  if (!inContent && DROP_OUTSIDE_CONTENT.has(el.tag)) return true
  const a = el.attrs
  if ("hidden" in a || a["aria-hidden"] === "true" || a["aria-modal"] === "true") return true
  if (a.role && DROP_ROLES.has(a.role.toLowerCase())) return true
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? "")) return true
  const tokens = `${a.class ?? ""} ${a.id ?? ""}`.split(/\s+/).filter(Boolean)
  return tokens.some((t) => DROP_TOKEN.test(t))
}

/** An absolute http(s) URL for a link, or null (javascript:, mailto:, a bare #fragment, an unparsable href). */
function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null
  const h = href.trim()
  if (!h || h.startsWith("#")) return null
  try {
    const u = new URL(h, base || undefined)
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null
  } catch {
    return null
  }
}

type Ctx = {
  base: string
  inContent: boolean
  inPre: boolean
  list: { ordered: boolean; n: number }[]
  links: boolean
}

const collapse = (s: string) => s.replace(/[\s\u00a0]+/g, " ")
/** Page text can't write Markdown emphasis, code or links. A list or heading marker at a text node's start is left as it is. */
const escapeInline = (s: string) => s.replace(/([\\`*_[\]])/g, "\\$1")

/** `**bold**` with the text's own leading and trailing spaces kept outside the markers. */
function wrap(s: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s
}

/** An element's text as one line of Markdown (links, bold, italics, code; blocks inside become spaces). */
function inline(nodes: Node[], ctx: Ctx): string {
  let out = ""
  for (const node of nodes) {
    if (typeof node === "string") {
      out += ctx.inPre ? decodeEntities(node) : escapeInline(collapse(decodeEntities(node)))
      continue
    }
    if (dropped(node, ctx.inContent)) continue
    const t = node.tag
    if (t === "br") {
      out += "\n"
      continue
    }
    const inner = () => inline(node.children, ctx)
    if (t === "a") {
      const text = inner().replace(/\s+/g, " ").trim()
      const url = ctx.links ? absolute(node.attrs.href, ctx.base) : null
      out += url && text ? `[${text}](${url.replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : "%20"))})` : text
    } else if (t === "strong" || t === "b") out += wrap(inner(), "**")
    else if (t === "em" || t === "i") out += wrap(inner(), "*")
    else if (t === "code" || t === "kbd" || t === "samp") {
      const s = textOf(node).replace(/\s+/g, " ").trim()
      out += s ? `\`${s.replace(/`/g, "'")}\`` : ""
    } else if (t === "sup") out += `^${inner().trim()}`
    else if (t === "table") out += ` ${tableAsText(node, ctx)} `
    else if (BLOCK.has(t)) out += ` ${inner()} `
    else out += inner()
  }
  return out
}

/** Plain text, no Markdown (code, table cells' fallback). */
function textOf(node: Node): string {
  if (typeof node === "string") return decodeEntities(node)
  if (RAW_SKIP.has(node.tag) || node.tag === "head") return ""
  if (node.tag === "br") return "\n"
  return node.children.map(textOf).join(BLOCK.has(node.tag) ? " " : "")
}

function rowsOf(table: El): El[] {
  const rows: El[] = []
  const walk = (e: El) => {
    for (const c of e.children) {
      if (typeof c === "string") continue
      if (c.tag === "tr") rows.push(c)
      else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") walk(c)
    }
  }
  walk(table)
  return rows
}

const cellText = (cell: El, ctx: Ctx) =>
  inline(cell.children, { ...ctx, inPre: false })
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim()

/** A table as a grid of cell texts: colspan repeats a cell across its columns, rowspan down its rows (labels stay on every row). */
function grid(table: El, ctx: Ctx): { cells: string[][]; head: boolean } {
  const rows = rowsOf(table)
  const out: string[][] = []
  const carry: { text: string; left: number }[] = []
  let head = false
  rows.forEach((tr, r) => {
    const row: string[] = []
    let col = 0
    const fill = () => {
      while ((carry[col]?.left ?? 0) > 0) {
        row[col] = carry[col].text
        carry[col].left--
        col++
      }
    }
    const cells = tr.children.filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th"))
    if (r === 0) head = tr.parent?.tag === "thead" || (cells.length > 0 && cells.every((c) => c.tag === "th"))
    for (const cell of cells) {
      fill()
      const text = cellText(cell, ctx)
      const span = Math.min(20, Math.max(1, parseInt(cell.attrs.colspan ?? "1", 10) || 1))
      const down = Math.min(50, Math.max(1, parseInt(cell.attrs.rowspan ?? "1", 10) || 1))
      for (let k = 0; k < span; k++) {
        row[col] = text
        if (down > 1) carry[col] = { text, left: down - 1 }
        col++
      }
    }
    fill()
    // Trailing rowspans past the last cell.
    for (let k = col; k < carry.length; k++)
      if ((carry[k]?.left ?? 0) > 0) {
        row[k] = carry[k].text
        carry[k].left--
      }
    if (row.some((c) => c)) out.push(row)
  })
  const width = Math.max(0, ...out.map((r) => r.length))
  for (const r of out) for (let k = 0; k < width; k++) r[k] ??= ""
  return { cells: out, head }
}

/** A nested table inside a cell: "a: b; c: d" rows, so its labels stay next to its values. */
function tableAsText(table: El, ctx: Ctx): string {
  return grid(table, ctx)
    .cells.map((r) => r.filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ")
}

function table(el: El, ctx: Ctx): string {
  const { cells } = grid(el, ctx)
  if (!cells.length) return ""
  const width = cells[0].length
  // A layout table (one column, or one cell): its cells are paragraphs, not data.
  if (width <= 1 || (cells.length === 1 && width <= 2))
    return cells
      .map((r) => r.filter(Boolean).join(" "))
      .filter(Boolean)
      .join("\n\n")
  const line = (r: string[]) => `| ${r.map((c) => c || " ").join(" | ")} |`
  const [first, ...rest] = cells
  return [line(first), `| ${first.map(() => "---").join(" | ")} |`, ...rest.map(line)].join("\n")
}

/** Block-level Markdown for a list of nodes. */
function blocks(nodes: Node[], ctx: Ctx): string {
  const out: string[] = []
  let run: Node[] = []
  const flush = () => {
    if (!run.length) return
    const s = inline(run, ctx)
      .split("\n")
      .map((l) => l.trim())
      .join("\n")
      .trim()
    if (s) out.push(s)
    run = []
  }
  for (const node of nodes) {
    if (typeof node !== "string" && dropped(node, ctx.inContent)) continue
    if (typeof node === "string" || !BLOCK.has(node.tag)) {
      run.push(node)
      continue
    }
    flush()
    const b = block(node, ctx)
    if (b.trim()) out.push(b)
  }
  flush()
  return out.join("\n\n")
}

function block(el: El, ctx: Ctx): string {
  const t = el.tag
  const content = ctx.inContent || t === "main" || t === "article" || el.attrs.role === "main"
  const c = content === ctx.inContent ? ctx : { ...ctx, inContent: content }
  if (/^h[1-6]$/.test(t)) {
    const s = inline(el.children, c).replace(/\s+/g, " ").trim()
    return s ? `${"#".repeat(Number(t[1]))} ${s}` : ""
  }
  if (t === "hr") return "---"
  if (t === "pre") {
    const s = textOf(el).replace(/^\n+|\s+$/g, "")
    return s ? `\`\`\`\n${s.replace(/```/g, "'''")}\n\`\`\`` : ""
  }
  if (t === "table") return table(el, c)
  if (t === "ul" || t === "ol") {
    const list = {
      ordered: t === "ol",
      n: Math.max(1, parseInt(el.attrs.start ?? "1", 10) || 1),
    }
    const items: string[] = []
    for (const li of el.children) {
      if (typeof li === "string" || dropped(li, c.inContent)) continue
      const body = li.tag === "li" ? blocks(li.children, { ...c, list: [...c.list, list] }) : blocks([li], c)
      if (!body.trim()) continue
      const marker = list.ordered ? `${list.n++}. ` : "- "
      const pad = " ".repeat(marker.length)
      items.push(
        marker +
          body
            .split("\n")
            .map((l, k) => (k === 0 || !l ? l : pad + l))
            .join("\n"),
      )
    }
    return items.join("\n")
  }
  if (t === "blockquote") {
    const s = blocks(el.children, c)
    return s
      ? s
          .split("\n")
          .map((l) => `> ${l}`.trimEnd())
          .join("\n")
      : ""
  }
  if (t === "dt") {
    const s = inline(el.children, c).replace(/\s+/g, " ").trim()
    return s ? `**${s}**` : ""
  }
  return blocks(el.children, c)
}

export type Converted = { markdown: string; title: string }

/**
 * `base`: the page's final URL, for relative links. `links: false` gives text without link targets (format "text").
 * Output is trimmed of blank-line runs and of lines that are only punctuation.
 */
export function htmlToMarkdown(html: string, base = "", { links = true }: { links?: boolean } = {}): Converted {
  const { root, title } = parseHtml(html)
  const baseHref = (() => {
    const b = find(root, (e) => e.tag === "base")?.attrs.href
    return b ? (absolute(b, base) ?? base) : base
  })()
  // With a <main> (or role="main") that holds real text, the page is that: everything around it is furniture.
  const main = find(root, (e) => e.tag === "main" || e.attrs.role === "main")
  const start = main && textOf(main).replace(/\s+/g, " ").trim().length >= 200 ? [main] : root.children
  const md = blocks(start, {
    base: baseHref,
    inContent: false,
    inPre: false,
    list: [],
    links,
  })
  const markdown = md
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .filter((l) => !/^[\s|*_•·>-]*$/.test(l) || /^\s*(---|\|[\s|:-]+\|)\s*$/.test(l) || l === "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { markdown, title }
}

/** The first element (document order) that `match` accepts. Iterative: a deep page can't overflow the stack. */
function find(root: El, match: (e: El) => boolean): El | null {
  const stack: Node[] = [...root.children].reverse()
  while (stack.length) {
    const n = stack.pop()!
    if (typeof n === "string") continue
    if (match(n)) return n
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k])
  }
  return null
}
