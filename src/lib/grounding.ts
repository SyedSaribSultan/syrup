/**
 * Where a web answer's facts came from, for the chat (docs/QUALITY.md Q4). Pure: the chat loads it in a lazy chunk
 * after an answer finishes (src/components/sources.tsx), and scripts/test-grounding.mjs runs the same code on its
 * labelled set to measure the soft flag's precision.
 *
 *   pagesFrom(parts)              the pages a turn read: webfetch results (by their Source header) and search results
 *   ground(answer, turn, session) numbered chips for links to pages read, each with the snippet that matches its line,
 *                                 and the soft flag: a money amount on a line that cites a page, not found in that page
 *
 * Everything here returns plain strings. The chat renders them as text, never as HTML: a fetched page is untrusted.
 */
import { mdLines, plain } from "./answer-checks/markdown"
import { parseAmounts } from "./answer-checks/money"
import { CALCULATED, indexNumbers, key } from "./answer-checks/provenance"
import { citedLinks, normalizeUrl } from "./answer-checks/urls"

/** A tool part as the chat has it (only what this reads). */
export type WebPart = {
  tool: string
  state: { status: string; input?: Record<string, unknown>; output?: string }
}

export type Page = {
  /** Normalised URL (answer-checks normalizeUrl): what a link in the answer is matched on. */
  id: string
  url: string
  title: string
  host: string
  fetched?: string
  /** "fetch": syrup opened the page. "search": only a search result's passages. */
  via: "fetch" | "search"
  text: string
}

const WEB = /^(webfetch|websearch)$/

/** Text from a page is shown in a card: control characters and bidi overrides out, length bounded. */
export function clean(s: string, max = 400): string {
  const t = s
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** Only http(s) URLs become pages: a "Source: javascript:…" line from a hostile page is dropped. */
const httpUrl = (u: string) => (/^https?:\/\/[^\s]+$/i.test(u) ? u : null)

/** The pages these parts read, in the order first read. A page both searched and fetched counts once, as fetched. */
export function pagesFrom(parts: WebPart[]): Page[] {
  const pages = new Map<string, Page>()
  const add = (p: Omit<Page, "id" | "host">) => {
    const id = normalizeUrl(p.url)
    if (!id) return
    const old = pages.get(id)
    if (!old) {
      pages.set(id, {
        ...p,
        id,
        host: hostOf(p.url),
        title: clean(p.title, 160),
      })
      return
    }
    if (p.via === "fetch" && old.via === "search")
      pages.set(id, {
        ...old,
        ...p,
        id,
        host: old.host,
        title: clean(p.title, 160) || old.title,
        text: `${p.text}\n\n${old.text}`,
      })
    else old.text += `\n\n${p.text}`
  }
  for (const part of parts) {
    if (!WEB.test(part.tool) || part.state.status !== "completed" || typeof part.state.output !== "string") continue
    const out = part.state.output
    if (part.tool === "webfetch") {
      const head = /^Source: (.*)\nTitle: (.*)\nFetched: (.*)\n---\n/.exec(out)
      const url = httpUrl(head?.[1].trim() ?? String(part.state.input?.url ?? ""))
      if (!url) continue
      add({
        url,
        title: head?.[2] === "(no title)" ? "" : (head?.[2] ?? ""),
        fetched: head?.[3].trim(),
        via: "fetch",
        text: head ? out.slice(head[0].length) : out,
      })
      continue
    }
    for (const block of out.split(/\n(?=Title: )/)) {
      const m = /^Title: (.*)\n(?:[^\n]*\n){0,3}?URL: (\S+)/.exec(block)
      const url = m && httpUrl(m[2])
      if (url) add({ url, title: m[1], via: "search", text: block })
    }
  }
  return [...pages.values()]
}

export type Snippet = { before: string; match: string; after: string }
export type Chip = {
  n: number
  page: Page
  snippet: Snippet | null
  flags: string[]
  /** The same amounts by the 0-based line of the answer that gives them (the chip on that line carries the flag). */
  flagsByLine: Record<number, string[]>
}
export type Grounding = {
  /** By normalised URL. Only links to pages read in this chat. */
  chips: Record<string, Chip>
  /** Pages this answer's turn read, in order. */
  read: Page[]
  flagged: number
}

const STOP = new Set(
  "about after also and are back been before being both but can could does each every from have here into just more most must only other over same some such than that their them then there these they this those through very what when where which while will with would your page site source sources says said".split(
    " ",
  ),
)
const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP.has(w))

/** ±`radius` characters of the page around position `at` (length `len`), cut at word ends. */
function around(text: string, at: number, len: number, radius = 140): Snippet {
  let a = Math.max(0, at - radius)
  let b = Math.min(text.length, at + len + radius)
  if (a > 0) a = text.indexOf(" ", a) + 1 || a
  if (b < text.length) b = text.lastIndexOf(" ", b) > at + len ? text.lastIndexOf(" ", b) : b
  return {
    before: (a > 0 ? "…" : "") + clean(text.slice(a, at), radius + 20).replace(/^…/, ""),
    match: clean(text.slice(at, at + len), 80),
    after: clean(text.slice(at + len, b), radius + 20) + (b < text.length ? "…" : ""),
  }
}

/** Page text without Markdown table pipes and emphasis, so a snippet reads as text. Positions keep their meaning. */
const readable = (s: string) => s.replace(/[|*_`#]/g, " ")

/** Where the line's amounts, or failing that its words, best match the page. */
function snippetFor(page: Page, lineTexts: string[]): Snippet | null {
  const text = readable(page.text)
  const idx = indexNumbers([text])
  for (const line of lineTexts) {
    for (const a of parseAmounts(line).filter((x) => x.kind === "money")) {
      const hit = idx.get(key(a.lo))?.[0]
      if (hit) {
        const m = /[\d][\d,.]*/.exec(text.slice(hit.pos))
        return around(text, hit.pos, m ? m[0].length : 1)
      }
    }
  }
  // No amount: the stretch of the page sharing the most words with the line(s).
  const want = new Set(lineTexts.flatMap(wordsOf))
  if (!want.size) return null
  let best = { at: -1, score: 0 }
  const parts = text.split(/(?<=[.!?\n])\s+/)
  let pos = 0
  for (const s of parts) {
    const start = text.indexOf(s, pos)
    pos = start + s.length
    const score = new Set(wordsOf(s).filter((w) => want.has(w))).size
    if (score > best.score) best = { at: start, score }
  }
  if (best.score < 2) return null
  const s = text.slice(best.at, best.at + 260)
  return {
    before: "",
    match: "",
    after: clean(s, 260) + (best.at + 260 < text.length ? "…" : ""),
  }
}

/**
 * The chips and flags for one finished answer. `turn`: pages this answer's turn read (the "Read N pages" footer).
 * `session`: every page read in the chat so far (a follow-up may cite a page read earlier).
 *
 * The soft flag, tuned for precision (docs/QUALITY.md Q4): only money amounts; only on a line that links a page
 * syrup read; only when no page that line links contains the number (as written, or scaled: 28k = 28,000); never on
 * a line that says it is a total, estimate, conversion or approximation; never for an amount marked approximate.
 */
export function ground(answer: string, turn: Page[], session: Page[]): Grounding {
  const byId = new Map<string, Page>()
  for (const p of [...session, ...turn]) if (!byId.has(p.id)) byId.set(p.id, p)
  const chips: Record<string, Chip> = {}
  const linesOf = new Map<string, number[]>()
  let n = 0
  const links = citedLinks(answer)
  for (const l of links) {
    const id = normalizeUrl(l.url)
    const page = id ? byId.get(id) : undefined
    if (!id || !page) continue
    if (!chips[id]) chips[id] = { n: ++n, page, snippet: null, flags: [], flagsByLine: {} }
    const ls = linesOf.get(id) ?? []
    if (!ls.includes(l.line)) ls.push(l.line)
    linesOf.set(id, ls)
  }
  const lines = mdLines(answer)
  const lineText = (i: number) => plain(lines[i]?.text ?? "")
  let flagged = 0
  // Flags, line by line: amounts not in any page the line cites.
  const cited = new Map<number, string[]>()
  for (const [id, ls] of linesOf) for (const i of ls) cited.set(i, [...(cited.get(i) ?? []), id])
  for (const [i, ids] of cited) {
    const t = lineText(i)
    if (CALCULATED.test(t)) continue
    const texts = ids.map((id) => chips[id].page.text)
    const idx = indexNumbers(texts)
    const missing: string[] = []
    for (const a of parseAmounts(t)) {
      if (a.kind !== "money" || a.approx) continue
      const ends = a.range ? [a.lo, a.hi] : [a.lo]
      if (ends.every((v) => idx.has(key(v)))) continue
      missing.push(`${a.text.trim()}${a.plus ? "+" : ""}`)
    }
    if (!missing.length) continue
    flagged += missing.length
    const chip = chips[ids[0]]
    for (const m of missing) if (!chip.flags.includes(m)) chip.flags.push(m)
    chip.flagsByLine[i] = missing
  }
  for (const [id, ls] of linesOf) chips[id].snippet = snippetFor(chips[id].page, ls.map(lineText))
  return { chips, read: turn, flagged }
}

/** A link's key in `chips`, or null. */
export const chipKey = (href: string | undefined) => (href ? normalizeUrl(href) : null)

/**
 * The soft flag ships on only at ≥ 95% precision on a blind labelled set (docs/QUALITY.md Q4; scripts/test-grounding.mjs
 * keeps this in line with the recorded blind precision). Off: chips and cards still show, without the flag. The switch
 * that turns it on: NEXT_PUBLIC_SYRUP_SOURCE_FLAGS=1 at build time, or localStorage "syrup.source-flags" = "on".
 */
export const SOURCE_FLAGS_DEFAULT = false

export function sourceFlagsEnabled(): boolean {
  if (SOURCE_FLAGS_DEFAULT || process.env.NEXT_PUBLIC_SYRUP_SOURCE_FLAGS === "1") return true
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("syrup.source-flags") === "on"
  } catch {
    return false
  }
}
