/**
 * Just enough Markdown structure for the checks: which lines are code, the GFM tables, and the
 * list blocks with the lines around them. Not a renderer; it only has to agree with one on the
 * shapes answers use.
 */

export type MdLine = { text: string; index: number; code: boolean }

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** Splits Markdown into lines and marks the ones inside fenced code blocks (fences included). */
export function mdLines(md: string): MdLine[] {
  const out: MdLine[] = []
  let open: { ch: string; len: number } | null = null
  md.split(/\r?\n/).forEach((text, index) => {
    const f = FENCE.exec(text)
    if (open) {
      out.push({ text, index, code: true })
      if (f && f[1][0] === open.ch && f[1].length >= open.len && !f[2].trim()) open = null
      return
    }
    // A backtick fence's info string can't contain a backtick (CommonMark), so "```a``` b" is inline code.
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      open = { ch: f[1][0], len: f[1].length }
      out.push({ text, index, code: true })
      return
    }
    out.push({ text, index, code: false })
  })
  return out
}

/** Text with Markdown decoration removed, for reading numbers: links keep their text, bare URLs and emphasis go. */
export function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<https?:\/\/[^>\s]+>/gi, " ")
    .replace(/https?:\/\/[^\s)<>\]]+/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\\([|*_`~[\]])/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/~~/g, "")
}

// ------------------------------------------------------------------ tables

export type TableRow = { line: number; cells: string[]; raw: string }
export type Table = { line: number; header: string[]; rows: TableRow[] }

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

function cellsOf(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ""
  let code = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|"
      i++
      continue
    }
    if (ch === "`") code = !code
    if (ch === "|" && !code) {
      cells.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/** GFM tables outside code blocks. A table is a header row, a separator row, then rows containing a pipe. */
export function parseTables(lines: MdLine[]): Table[] {
  const out: Table[] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i]
    const sep = lines[i + 1]
    if (head.code || sep.code || !head.text.includes("|") || !SEPARATOR.test(sep.text) || !sep.text.includes("-")) continue
    const header = cellsOf(head.text)
    const ncol = cellsOf(sep.text).length
    if (header.length !== ncol || ncol < 2) continue
    const rows: TableRow[] = []
    let j = i + 2
    for (; j < lines.length && !lines[j].code && lines[j].text.includes("|") && lines[j].text.trim(); j++) rows.push({ line: lines[j].index, cells: cellsOf(lines[j].text), raw: lines[j].text })
    out.push({ line: head.index, header, rows })
    i = j - 1
  }
  return out
}

// ------------------------------------------------------------------ lists

export type ListItem = { line: number; indent: number; text: string; raw: string }
/** A run of list items (blank lines and indented continuation lines allowed inside), with the prose next to it. */
export type ListBlock = {
  /** Items at the block's outermost level only; nested items are details, not parts. */
  items: ListItem[]
  /** Up to two prose lines just before the list (same section), nearest first. */
  before: { line: number; text: string }[]
  /** The first prose line after the list, if it follows within one blank line. */
  after: { line: number; text: string } | null
  firstLine: number
  lastLine: number
}

const BULLET = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/
const isHeading = (s: string) => /^\s{0,3}#{1,6}\s/.test(s)
const isTableLine = (s: string) => /^\s*\|/.test(s)
const isRule = (s: string) => /^\s{0,3}(?:[-*_]\s*){3,}$/.test(s)

export function parseLists(lines: MdLine[]): ListBlock[] {
  const out: ListBlock[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    const b = !l.code && !isRule(l.text) ? BULLET.exec(l.text) : null
    if (!b) {
      i++
      continue
    }
    const start = i
    const all: ListItem[] = []
    let last = i
    for (; i < lines.length; i++) {
      const cur = lines[i]
      if (cur.code) {
        // A fence indented under an item belongs to it; one at the margin ends the list.
        if (/^\s{2,}/.test(cur.text)) {
          last = i
          continue
        }
        break
      }
      if (!cur.text.trim()) {
        // A blank line continues the list only if the next non-blank line is an item or indented.
        let k = i + 1
        while (k < lines.length && !lines[k].text.trim()) k++
        if (k < lines.length && !lines[k].code && (BULLET.test(lines[k].text) || /^\s{2,}\S/.test(lines[k].text)) && !isRule(lines[k].text)) continue
        break
      }
      const m = !isRule(cur.text) ? BULLET.exec(cur.text) : null
      if (m) {
        all.push({ line: cur.index, indent: m[1].replace(/\t/g, "    ").length, text: m[2], raw: cur.text })
        last = i
        continue
      }
      if (/^\s{2,}\S/.test(cur.text)) {
        last = i
        continue
      }
      break
    }
    const top = Math.min(...all.map((x) => x.indent))
    const items = all.filter((x) => x.indent <= top + 1)
    const before: { line: number; text: string }[] = []
    for (let k = start - 1; k >= 0 && before.length < 2; k--) {
      const t = lines[k]
      if (!t.text.trim()) continue
      if (t.code || isHeading(t.text) || isTableLine(t.text) || isRule(t.text) || BULLET.test(t.text)) break
      before.push({ line: t.index, text: t.text })
    }
    let after: ListBlock["after"] = null
    let k = last + 1
    let blanks = 0
    while (k < lines.length && !lines[k].text.trim()) {
      blanks++
      k++
    }
    if (k < lines.length && blanks <= 1) {
      const t = lines[k]
      if (!t.code && !isTableLine(t.text) && !isRule(t.text) && !BULLET.test(t.text)) after = { line: t.index, text: t.text }
    }
    out.push({ items, before, after, firstLine: lines[start].index, lastLine: lines[last].index })
    i = last + 1
  }
  return out
}
