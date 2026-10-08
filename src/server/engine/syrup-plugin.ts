/**
 * syrup's OpenCode plugin: one file, no dependencies, run by OpenCode's Bun in both modes.
 * sidecar/build.mjs bundles it to .sidecar/syrup-plugin.js; syrupEngineConfig (engine/opencode.ts)
 * loads it with `"plugin": ["file://…"]`: locally from .sidecar/, in the sandbox from
 * /vercel/.syrup/syrup-plugin.js (written in the sidecar's writeFiles batch). Loading any plugin
 * makes OpenCode install @opencode-ai/plugin into its config dirs unless they are prepared first
 * (engine/config-dirs.ts, docs/QUALITY.md Q0 "hard rule").
 *
 * Features are independent functions of the environment that return hooks, or null to stay out:
 *   - evalReplay (Q1): web tools answer from a recorded cassette while SYRUP_EVAL_REPLAY is set.
 *   - contextHygiene (Q2, on unless SYRUP_CONTEXT_HYGIENE=0): web results trimmed at the source,
 *     web results of earlier user turns masked in what is sent, a shorter websearch definition,
 *     and no "continue" request after a compaction that followed a finished answer.
 *   - the Q4 webfetch override joins FEATURES below.
 * The two are independent: the replay only decides where web results come from, the hygiene only
 * what happens to them afterwards, so an eval measures the hygiene production runs. With every
 * feature off the plugin returns no hooks at all, so the engine (tools, prompts, requests) is
 * exactly what it is without the plugin.
 *
 * OpenCode calls every function the module exports as a plugin, so this file exports exactly one.
 * Tests drive it through that export (scripts/test-plugin.mjs).
 */
import fs from "node:fs"

// ---------------------------------------------------------------- the hook shapes used here (OpenCode 1.18.32)

type ToolContext = { sessionID: string; messageID?: string; agent?: string; callID?: string; abort?: AbortSignal }
type ToolResult = { title: string; output: string; metadata: Record<string, unknown> }
type ToolDef = {
  description: string
  /** OpenCode builds a schema from these keys; `tool.definition` then replaces it with the built-in one. */
  args: Record<string, unknown>
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}
type DefinitionHook = (input: { toolID: string }, output: { description: string; parameters?: unknown; jsonSchema?: unknown }) => Promise<void>
type ToolState = { status: string; input?: Record<string, unknown>; output?: string; time?: { compacted?: number } }
type Part = { type: string; tool?: string; state?: ToolState; messageID?: string }
type Message = { info: { id?: string; role: string; sessionID?: string; parentID?: string; summary?: unknown; finish?: string }; parts: Part[] }
type Hooks = {
  tool?: Record<string, ToolDef>
  "tool.definition"?: DefinitionHook
  "tool.execute.before"?: (input: { tool: string; sessionID: string; callID: string }, output: { args: Record<string, unknown> }) => Promise<void>
  "tool.execute.after"?: (input: { tool: string; sessionID: string; callID: string; args: unknown }, output: { title: string; output: string; metadata: Record<string, unknown> }) => Promise<void>
  "experimental.chat.messages.transform"?: (input: unknown, output: { messages: Message[] }) => Promise<void>
  "experimental.compaction.autocontinue"?: (input: { sessionID: string; overflow: boolean }, output: { enabled: boolean }) => Promise<void>
  event?: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>
}
type Env = Record<string, string | undefined>
type Feature = (env: Env) => Hooks | null

// ---------------------------------------------------------------- eval replay (Q1)

/**
 * OpenCode 1.18.32's own definitions of the tools the replay stands in for, word for word (captured
 * from GET /experimental/tool; scripts/test-plugin.mjs and the Q1 proof compare them with a live
 * engine), so the model sees the same tools in an eval as in production. `codesearch` is not a
 * tool in 1.18.32, so it has no stand-in.
 */
function builtinWebsearchDescription(year: number): string {
  return [
    "- Search the web using the session's web search provider - performs real-time web searches and can scrape content from specific URLs",
    "- Provides up-to-date information for current events and recent data",
    "- Supports configurable result counts and returns the content from the most relevant websites",
    "- Use this tool for accessing information beyond knowledge cutoff",
    "- Searches are performed automatically within a single API call",
    "",
    "Usage notes:",
    "  - Supports live crawling modes when available: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)",
    "  - Search types when available: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)",
    "  - Configurable context length for optimal LLM integration",
    "  - Domain filtering and advanced search options available",
    "",
    `The current year is ${year}. You MUST use this year when searching for recent information or current events`,
    `- Example: If the current year is ${year} and the user asks for "latest AI news", search for "AI news ${year}", NOT "AI news ${year - 1}"`,
    "",
  ].join("\n")
}

const WEBSEARCH_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    query: { type: "string", description: "Websearch query" },
    numResults: { type: "number", description: "Number of search results to return (default: 8)" },
    livecrawl: {
      type: "string",
      enum: ["fallback", "preferred"],
      description: "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
    },
    type: { type: "string", enum: ["auto", "fast", "deep"], description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search" },
    contextMaxCharacters: { type: "number", description: "Maximum characters for context string optimized for LLMs (default: 10000)" },
  },
  required: ["query"],
}

const WEBFETCH_DESCRIPTION = [
  "- Fetches content from a specified URL",
  "- Takes a URL and optional format as input",
  "- Fetches the URL content, converts to requested format (markdown by default)",
  "- Returns the content in the specified format",
  "- Use this tool when you need to retrieve and analyze web content",
  "",
  "Usage notes:",
  "  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.",
  "  - The URL must be a fully-formed valid URL",
  "  - HTTP URLs will be automatically upgraded to HTTPS",
  '  - Format options: "markdown" (default), "text", or "html"',
  "  - This tool is read-only and does not modify any files",
  "  - Results may be summarized if the content is very large",
  "",
].join("\n")

const WEBFETCH_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch content from" },
    format: { type: "string", enum: ["text", "markdown", "html"], description: "The format to return the content in (text, markdown, or html). Defaults to markdown.", default: "markdown" },
    timeout: { type: "number", description: "Optional timeout in seconds (max 120)" },
  },
  required: ["url"],
}

/** OpenCode's own words when a search finds nothing (websearch.ts). */
const NO_RESULTS = "No search results found. Please try a different query."

type Entry = { tool: string; key: string; input?: Record<string, unknown>; title?: string; output: string }
type Cassette = { format?: string; version?: number; entries: Entry[]; synthetic?: boolean }

/** websearch key: lower case, punctuation dropped, whitespace collapsed. */
function searchKey(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** webfetch key: https, lower-case host, no fragment, no utm_* parameters, no trailing slash. */
function urlKey(raw: string): string {
  try {
    const u = new URL(raw.trim())
    if (u.protocol === "http:") u.protocol = "https:"
    u.hash = ""
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k)
    const s = u.toString()
    return s.endsWith("/") ? s.slice(0, -1) : s
  } catch {
    return raw.trim()
  }
}

function jaccard(a: string, b: string): number {
  const x = new Set(a.split(" ").filter(Boolean))
  const y = new Set(b.split(" ").filter(Boolean))
  if (!x.size || !y.size) return 0
  let both = 0
  for (const t of x) if (y.has(t)) both++
  return both / (x.size + y.size - both)
}

/** The cassette at `file`, re-read whenever the file changes (the eval runner swaps it between cases). */
function cassetteReader(file: string): () => Cassette {
  let at = -1
  let value: Cassette = { entries: [] }
  return () => {
    let mtime = -2
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {}
    if (mtime === at) return value
    at = mtime
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Cassette
      value = { ...raw, entries: Array.isArray(raw.entries) ? raw.entries : [] }
    } catch {
      value = { entries: [] }
    }
    return value
  }
}

class ArgsError extends Error {}

/** Checks args against a JSON schema of the flat kind the web tools use (types, enums, required). */
function validate(tool: string, args: Record<string, unknown>, schema: { properties: Record<string, { type: string; enum?: string[] }>; required: string[] }) {
  const bad: string[] = []
  if (!args || typeof args !== "object") throw new ArgsError(`The ${tool} tool was called with invalid arguments: expected an object.`)
  for (const k of schema.required) if (args[k] === undefined || args[k] === null || args[k] === "") bad.push(`${k}: required`)
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k]
    if (!p || v === undefined) continue
    if (p.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) bad.push(`${k}: expected a number`)
    if (p.type === "string" && typeof v !== "string") bad.push(`${k}: expected a string`)
    if (p.enum && !p.enum.includes(String(v))) bad.push(`${k}: expected one of ${p.enum.join(", ")}`)
  }
  if (bad.length) throw new ArgsError(`The ${tool} tool was called with invalid arguments: ${bad.join("; ")}. Please rewrite the input so it satisfies the expected schema.`)
}

/** Plain-object args: OpenCode keeps these keys when it parses a call (`tool.definition` sets the real schema). */
const argsOf = (schema: { properties: Record<string, unknown> }) => Object.fromEntries(Object.keys(schema.properties).map((k) => [k, schema.properties[k]]))

/**
 * While SYRUP_EVAL_REPLAY names a cassette file, `websearch` and `webfetch` answer from it and never
 * touch the network. A plugin tool with a built-in's name replaces the built-in (verified on 1.18.32
 * in Q0), and `tool.definition` gives it the built-in's description and schema, so the model sees
 * the production tools. Lookups: exact key, then (search) the nearest recorded query by word
 * overlap (Jaccard ≥ 0.5, "fuzzy"), then a "*" entry ("fallback", for synthetic cassettes), else
 * what the real tool says on a miss. Every result carries metadata.replay for the runner's
 * hit-rate count.
 */
const evalReplay: Feature = (env) => {
  const file = env.SYRUP_EVAL_REPLAY
  if (!file) return null
  const cassette = cassetteReader(file)
  const year = new Date().getFullYear()
  const definitions: Record<string, { description: string; jsonSchema: unknown }> = {
    websearch: { description: builtinWebsearchDescription(year), jsonSchema: WEBSEARCH_SCHEMA },
    webfetch: { description: WEBFETCH_DESCRIPTION, jsonSchema: WEBFETCH_SCHEMA },
  }

  const websearch: ToolDef = {
    description: definitions.websearch.description,
    args: argsOf(WEBSEARCH_SCHEMA),
    async execute(args) {
      validate("websearch", args, WEBSEARCH_SCHEMA)
      const query = String(args.query)
      const key = searchKey(query)
      const entries = cassette().entries.filter((e) => e.tool === "websearch")
      const title = (e?: Entry) => e?.title ?? `Exa Web Search: ${query}`
      const exact = entries.find((e) => e.key === key)
      if (exact) return { title: title(exact), output: exact.output, metadata: { replay: { mode: "hit", key } } }
      let best: { e: Entry; score: number } | null = null
      for (const e of entries) {
        if (e.key === "*") continue
        const score = jaccard(key, e.key)
        if (!best || score > best.score) best = { e, score }
      }
      if (best && best.score >= 0.5) return { title: title(), output: best.e.output, metadata: { replay: { mode: "fuzzy", key, matched: best.e.key, score: Number(best.score.toFixed(2)) } } }
      const any = entries.find((e) => e.key === "*")
      if (any) return { title: title(), output: any.output, metadata: { replay: { mode: "fallback", key } } }
      return { title: title(), output: NO_RESULTS, metadata: { replay: { mode: "miss", key } } }
    },
  }

  const webfetch: ToolDef = {
    description: definitions.webfetch.description,
    args: argsOf(WEBFETCH_SCHEMA),
    async execute(args) {
      validate("webfetch", args, WEBFETCH_SCHEMA)
      const url = String(args.url)
      if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http:// or https://")
      const key = urlKey(url)
      const hit = cassette().entries.find((e) => e.tool === "webfetch" && urlKey(e.key) === key)
      // A page the cassette doesn't have behaves like a dead link, as the real tool reports one.
      if (!hit) throw new Error("Request failed with status code: 404")
      return { title: hit.title ?? `${url} (text/html)`, output: hit.output, metadata: { replay: { mode: "hit", key } } }
    },
  }

  return {
    tool: { websearch, webfetch },
    "tool.definition": async (input, output) => {
      const d = definitions[input.toolID]
      if (!d) return
      output.description = d.description
      output.jsonSchema = d.jsonSchema
    },
  }
}

// ---------------------------------------------------------------- context hygiene (Q2)

/**
 * The numbers (docs/QUALITY.md Q2; the design is the context report §5). A search shows at most 5
 * results and ~6,000 characters (8,000 at most); a fetched page at most 12,000; web results of
 * earlier user turns become a stub; the current turn keeps its newest 3 web results verbatim and
 * the rest only while they fit 16K tokens (chars / 4, OpenCode's own estimate).
 */
const HYGIENE = {
  numResults: 5,
  maxNumResults: 6,
  results: 5,
  target: 6_000,
  hard: 8_000,
  passage: 600,
  unitsPerResult: 4,
  fetchCap: 12_000,
  keepNewest: 3,
  turnBudgetTokens: 16_000,
  stubSources: 5,
}
const WEB_TOOLS = new Set(["websearch", "webfetch"])
const TRIM_NOTE = "[Trimmed to the passages most relevant to the query"

/** OpenCode's own cut (tool/truncate.ts): "...N bytes truncated..." and a hint about a saved file the model shouldn't read. */
const ENGINE_TRUNCATION = /\n*\.\.\.\d+ (?:bytes|lines) truncated\.\.\.[\s\S]*$/

const isTableLine = (line: string) => {
  const t = line.trim()
  return t.startsWith("|") || (t.endsWith("|") && (t.match(/\|/g) ?? []).length >= 2)
}
const isSeparator = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim())
const columns = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length

/**
 * Cuts `text` to at most `cap` characters at a line end, never inside a table: a table the cut would
 * split goes whole after the cut, unless it starts in the first half (a huge table), which then
 * keeps its header and separator and loses its last rows. Returns the kept text.
 */
function cutKeepingTables(text: string, cap: number): string {
  if (text.length <= cap) return text
  let end = text.lastIndexOf("\n", cap)
  if (end < cap / 2) end = cap
  const kept = text.slice(0, end)
  const lines = kept.split("\n")
  const nextLine = text.slice(end + 1).split("\n", 1)[0] ?? ""
  if (end === cap || !isTableLine(nextLine) || !isTableLine(lines[lines.length - 1])) return kept.trimEnd()
  let start = lines.length - 1
  while (start > 0 && isTableLine(lines[start - 1])) start--
  const tableAt = lines.slice(0, start).join("\n").length
  if (tableAt >= cap / 2) return lines.slice(0, start).join("\n").trimEnd()
  // A table bigger than half the cap: whole rows, its header and separator first (they come first anyway).
  return kept.trimEnd()
}

type ExaResult = { title: string; url: string; published?: string; body: string }

/**
 * Exa's MCP format: blocks joined by "---" (or only by a blank line), each "Title: / URL: /
 * Published: / Author: / Highlights:". Null when it isn't that.
 */
function parseExa(text: string): ExaResult[] | null {
  if (!text.startsWith("Title: ")) return null
  const blocks = text.split(/\n\n+(?:---\n+)?(?=Title: [^\n]*\n(?:(?:Published|Author|ID): [^\n]*\n)*URL: )/)
  const out: ExaResult[] = []
  for (const b of blocks) {
    const m = /^Title: (.*)\n(?:(?:Published|Author|ID): [^\n]*\n)*URL: (\S+)[^\n]*\n?/.exec(b)
    if (!m) continue
    let rest = b.slice(m[0].length)
    let published: string | undefined
    for (;;) {
      const h = /^(Published|Author|Image|Favicon|Score|ID): ?(.*)\n?/.exec(rest)
      if (!h) break
      if (h[1] === "Published" && h[2] && h[2] !== "N/A") published = h[2].slice(0, 10)
      rest = rest.slice(h[0].length)
    }
    rest = rest.replace(/^(Highlights|Text|Summary):[ \t]*\n?/, "")
    out.push({ title: m[1].trim(), url: m[2].trim(), published, body: rest })
  }
  // Half the blocks or more unreadable: the format changed, so the plain cut is safer than guessing.
  const candidates = text.match(/^Title: /gm)?.length ?? 0
  return out.length && out.length * 2 >= candidates ? out : null
}

type Unit = { result: number; order: number; text: string; table?: { head: string[]; rows: string[] }; score: number }

/** Splits a passage longer than `max` at sentence ends, then (one huge sentence) at spaces, then anywhere. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  const pieces = text.split(/(?<=[.!?])\s+/)
  let cur = ""
  const flush = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ""
  }
  for (let p of pieces) {
    while (p.length > max) {
      flush()
      let at = p.lastIndexOf(" ", max)
      if (at < max / 2) at = max
      out.push(p.slice(0, at).trim())
      p = p.slice(at).trim()
    }
    if (cur && cur.length + 1 + p.length > max) flush()
    cur = cur ? `${cur} ${p}` : p
  }
  flush()
  return out
}

/** The line above table rows that came without their header, so the model knows the columns are unknown. */
const ORPHAN_LABEL = "(table rows without their header row: the column meanings were not in the search result)"

const BOILERPLATE = /cookie|subscribe|sign ?in\b|log ?in\b|newsletter|all rights reserved|privacy policy|terms of (use|service)|enable javascript/i

/**
 * One result's highlights as units: text passages (at most 600 characters, short paragraphs packed
 * together) and whole tables. A table row is never a unit of its own and never gets a header that
 * isn't its own: rows that continue a table straight after Exa's "..." break (same column count,
 * nothing in between) join that table. Rows Exa gave without any header stay one block, kept whole or
 * not at all, under ORPHAN_LABEL: never a borrowed header, because a number under the wrong column label
 * is how a price gets relabelled (QUALITY.md §1, error 3).
 */
function unitsOf(body: string, result: number): Unit[] {
  const units: Unit[] = []
  let open: Unit | null = null
  for (const snippet of body.split(/\n[ \t]*\.\.\.[ \t]*(?:\n|$)/)) {
    const lines = snippet.split("\n")
    let i = 0
    let text: string[] = []
    const flushText = () => {
      const paragraphs = text
        .join("\n")
        .split(/\n\s*\n/)
        .map((p) => p.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim())
        .filter(Boolean)
      text = []
      let cur = ""
      const push = (s: string) => {
        if (s.replace(/\s/g, "").length < 20) return
        if (BOILERPLATE.test(s) && s.length < 300) return
        units.push({ result, order: units.length, text: s, score: 0 })
      }
      for (const p of paragraphs.flatMap((p) => splitLong(p, HYGIENE.passage))) {
        if (cur && cur.length + 1 + p.length > HYGIENE.passage) {
          push(cur)
          cur = ""
        }
        cur = cur ? `${cur}\n${p}` : p
      }
      if (cur) push(cur)
    }
    while (i < lines.length) {
      if (!isTableLine(lines[i])) {
        if (lines[i].trim()) open = null
        text.push(lines[i++])
        continue
      }
      flushText()
      const block: string[] = []
      while (i < lines.length && isTableLine(lines[i])) block.push(lines[i++].trim())
      const headed = block.length >= 2 && isSeparator(block[1])
      const rows = headed ? block.slice(2) : block
      if (!headed && open?.table && columns(open.table.head[0] ?? open.table.rows[0]) === columns(rows[0])) {
        // The same table (or the same headerless rows), cut by Exa's "..." between two highlights.
        open.table.rows.push(...rows)
        continue
      }
      open = { result, order: units.length, text: "", table: { head: headed ? block.slice(0, 2) : [], rows }, score: 0 }
      units.push(open)
    }
    flushText()
  }
  for (const u of units) if (u.table) u.text = [...(u.table.head.length ? u.table.head : [ORPHAN_LABEL]), ...u.table.rows].join("\n")
  return units
}

const STOP = new Set("a an and are as at be by for from how i in is it of on or the to what when where which who why with vs best top latest 2024 2025 2026 2027".split(" "))
const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
const queryTerms = (q: string) => [...new Set(words(q).filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w)))]
const NUMBER_SEEKING = /\b(price|prices|pricing|cost|costs|fee|fees|rate|rates|how (many|much)|when|year|budget|salary|pay|percent|exchange|convert|total|cheap|expensive|usd|pkr|eur|gbp|inr|height|tall|population|number)\b|[%$€£₹]/i

/**
 * BM25 over the query's terms; when the query asks for a number, +1 for a passage or table with one
 * and up to +1.5 more for many (a price table beats a sentence saying prices vary); +0.3 for Exa's
 * first two results; a fragment under 120 characters (a heading, a stray cell) counts for less.
 */
function score(units: Unit[], query: string) {
  const terms = queryTerms(query)
  const toks = units.map((u) => words(u.text))
  const avg = toks.reduce((n, t) => n + t.length, 0) / Math.max(1, toks.length) || 1
  const df = new Map(terms.map((t) => [t, toks.filter((ws) => ws.includes(t)).length]))
  const numeric = NUMBER_SEEKING.test(query)
  units.forEach((u, i) => {
    let s = 0
    for (const t of terms) {
      const tf = toks[i].filter((w) => w === t).length
      if (!tf) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (units.length - n + 0.5) / (n + 0.5))
      s += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * toks[i].length) / avg))
    }
    const numbers = (u.text.match(/\d[\d,.]*/g) ?? []).length
    if (numeric && numbers) s += 1 + Math.min(1.5, numbers / 8)
    if (u.result < 2) s += 0.3
    u.score = s * Math.min(1, u.text.length / 120)
  })
}

function shingles(text: string): Set<string> {
  const w = words(text)
  if (w.length < 5) return new Set([w.join(" ")])
  const out = new Set<string>()
  for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(" "))
  return out
}
function overlap(a: Set<string>, b: Set<string>) {
  let both = 0
  for (const x of a) if (b.has(x)) both++
  return both / (a.size + b.size - both || 1)
}

/** A table cut to `room` characters: its header and separator, then its best rows in their order. Null if no row fits. */
function cutTable(u: Unit, room: number, terms: string[]): { text: string; shown: number; of: number } | null {
  const t = u.table!
  const head = t.head.join("\n")
  let left = room - head.length - 60
  // A row's weight: the query terms it holds, and half a point for a number.
  const weight = (row: string) => {
    const w = words(row)
    return terms.filter((x) => w.includes(x)).length + (/\d/.test(row) ? 0.5 : 0)
  }
  const ranked = t.rows.map((r, i) => ({ r, i, s: weight(r) })).sort((a, b) => b.s - a.s || a.i - b.i)
  const keep = new Set<number>()
  for (const x of ranked) {
    if (x.r.length + 1 > left) continue
    keep.add(x.i)
    left -= x.r.length + 1
  }
  if (!keep.size) return null
  const rows = t.rows.filter((_, i) => keep.has(i))
  return { text: [head, ...rows].filter(Boolean).join("\n"), shown: rows.length, of: t.rows.length }
}

/** Trims Exa search output to the query (docs/QUALITY.md Q2). Returns the text and how it was trimmed. */
function trimSearch(raw: string, query: string): { text: string; mode: "unchanged" | "passages" | "cut" } {
  const text = raw.replace(ENGINE_TRUNCATION, "")
  // Already trimmed (a replayed recording of a trimmed chat), or small enough as it is.
  if (text.includes(TRIM_NOTE) || text.length <= HYGIENE.target) return { text, mode: "unchanged" }
  const parsed = parseExa(text)
  if (!parsed) {
    if (text.length <= HYGIENE.hard) return { text: raw, mode: "unchanged" }
    const kept = cutKeepingTables(text, HYGIENE.hard - 120)
    return { text: `${kept}\n\n[Search output trimmed to its first ${kept.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters to save context.]`, mode: "cut" }
  }
  // Exact duplicate URLs go; Exa's order decides which 5 results are shown.
  const seen = new Set<string>()
  const results = parsed.filter((r) => {
    const k = urlKey(r.url)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const shown = results.slice(0, HYGIENE.results)
  const units = shown.flatMap((r, i) => unitsOf(r.body, i))
  score(units, query)
  const terms = queryTerms(query)
  const headers = shown.map((r) => `Title: ${r.title}\nURL: ${r.url}${r.published ? `\nPublished: ${r.published}` : ""}`)
  let total = headers.reduce((n, h) => n + h.length + 20, 0) + 260
  const picked = new Map<Unit, string>()
  const perResult = new Map<number, number>()
  const kept: Set<string>[] = []
  const tryAdd = (u: Unit, limit: number) => {
    if (picked.has(u) || (perResult.get(u.result) ?? 0) >= HYGIENE.unitsPerResult) return
    const sh = shingles(u.text)
    if (kept.some((k) => overlap(sh, k) >= 0.6)) return
    let body = u.text
    if (total + body.length + 5 > limit) {
      // A table that doesn't fit whole keeps its header and its best rows; a passage, or rows without a
      // header (never split), that doesn't fit waits.
      if (!u.table?.head.length || !u.table.rows.length) return
      const cut = cutTable(u, Math.min(limit, HYGIENE.hard) - total - 5, terms)
      if (!cut || cut.shown < Math.min(2, cut.of)) return
      body = `${cut.text}\n(table cut: ${cut.shown} of ${cut.of} rows shown)`
    }
    picked.set(u, body)
    kept.push(sh)
    perResult.set(u.result, (perResult.get(u.result) ?? 0) + 1)
    total += body.length + 5
  }
  const ranked = [...units].sort((a, b) => b.score - a.score || a.result - b.result || a.order - b.order)
  // Every shown result first gets its best unit that fits its share of the target, then the best units
  // overall until the target. A table may go past the target, up to the hard cap, to stay whole.
  const share = HYGIENE.target / Math.max(1, shown.length)
  for (let r = 0; r < shown.length; r++) {
    const best = ranked.find((u) => u.result === r && u.text.length <= share)
    if (best) tryAdd(best, HYGIENE.target)
  }
  for (const u of ranked) {
    if (total >= HYGIENE.target) break
    tryAdd(u, u.table ? HYGIENE.hard : HYGIENE.target)
  }
  const blocks = shown.map((r, i) => {
    const mine = units.filter((u) => u.result === i && picked.has(u)).map((u) => picked.get(u)!)
    return mine.length ? `${headers[i]}\nHighlights:\n${mine.join("\n\n...\n\n")}` : headers[i]
  })
  const extra = results.slice(HYGIENE.results).map((r) => r.url)
  const note = `${TRIM_NOTE}: ${shown.length} of ${parsed.length} results${extra.length ? ` (also found: ${extra.join(" ")})` : ""}. Use webfetch on a URL to read the full page.]`
  let out = `${blocks.join("\n\n---\n\n")}\n\n${note}`
  if (out.length > HYGIENE.hard) out = `${cutKeepingTables(out, HYGIENE.hard - note.length - 2)}\n\n${note}`
  return { text: out, mode: "passages" }
}

/** A fetched page cut to 12,000 characters at a line end, tables kept whole at the cut. */
function trimFetch(raw: string): { text: string; mode: "unchanged" | "cut" } {
  const text = raw.replace(ENGINE_TRUNCATION, "")
  if (text.length <= HYGIENE.fetchCap) return { text: raw, mode: "unchanged" }
  const note = (n: number) => `\n\n[Page trimmed to its first ${n.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters to save context.]`
  const kept = cutKeepingTables(text, HYGIENE.fetchCap - note(HYGIENE.fetchCap).length)
  return { text: kept + note(kept.length), mode: "cut" }
}

/** Title and URL pairs in a search output, raw or trimmed (both keep Exa's "Title:" / "URL:" lines). */
function sourcesIn(output: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = []
  for (const m of output.matchAll(/^Title: (.*)\n(?:[^\n]*\n)??URL: (\S+)/gm)) out.push({ title: m[1].trim(), url: m[2] })
  if (!out.length) for (const m of output.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) out.push({ title: "", url: m[0] })
  const seen = new Set<string>()
  return out.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)))
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The stub a masked web result is sent as: deterministic, so a masked prefix stays byte-identical. */
function stubFor(part: Part, earlier: boolean): string {
  const input = part.state?.input ?? {}
  if (part.tool === "webfetch") {
    const url = clip(String(input.url ?? ""), 300)
    return earlier ? `[Earlier fetch of ${url} cleared to save context. Fetch it again if needed.]` : `[Fetch of ${url} cleared to save context; newer web results of this turn are kept. Fetch it again if needed.]`
  }
  const query = clip(String(input.query ?? "").replace(/\s+/g, " "), 200)
  const sources = sourcesIn(part.state?.output ?? "")
    .slice(0, HYGIENE.stubSources)
    .map((s) => `${clip(s.title, 80)} ${s.url}`.trim())
    .join("; ")
  const tail = "Search again or webfetch a URL if you need the details.]"
  return earlier
    ? `[Earlier web search "${query}" cleared to save context. Sources: ${sources || "none"}. The answer given at the time is in the conversation above. ${tail}`
    : `[Web search "${query}" cleared to save context; newer web results of this turn are kept. Sources: ${sources || "none"}. ${tail}`
}

/**
 * Masks web results in the messages about to be sent (fresh copies each step; storage and the UI
 * keep the full text): every one from a user turn before the current one, and in the current turn
 * the oldest ones while the turn's web results exceed 16K tokens, never the newest 3. Only tool
 * outputs change: never inputs, call ids, assistant text or reasoning.
 */
function maskWebResults(messages: Message[]) {
  let current = -1
  messages.forEach((m, i) => {
    if (m.info.role === "user") current = i
  })
  if (current < 0) return
  const web = (p: Part) => p.type === "tool" && WEB_TOOLS.has(p.tool ?? "") && p.state?.status === "completed" && typeof p.state.output === "string" && !p.state.time?.compacted
  for (let i = 0; i < current; i++) for (const p of messages[i].parts) if (web(p)) p.state!.output = stubFor(p, true)
  const now = messages.slice(current + 1).flatMap((m) => m.parts.filter(web))
  let tokens = now.reduce((n, p) => n + p.state!.output!.length / 4, 0)
  for (let i = 0; i < now.length - HYGIENE.keepNewest && tokens > HYGIENE.turnBudgetTokens; i++) {
    tokens -= now[i].state!.output!.length / 4
    now[i].state!.output = stubFor(now[i], false)
  }
}

/**
 * Whether the compaction that just ran followed a finished answer to the latest user message. Then
 * OpenCode's synthetic "Continue if you have next steps…" request only buys an extra reply nobody
 * asked for; mid-task (the last step called tools) or with a question still unanswered it is what
 * keeps the agent going, so it stays. Fed by the engine's own message events.
 */
function compactionTracker() {
  type S = { users: string[]; compactions: Set<string>; answer?: { parentID?: string; finish: string } }
  const sessions = new Map<string, S>()
  const get = (id: string) => {
    let s = sessions.get(id)
    if (!s) {
      s = { users: [], compactions: new Set() }
      sessions.set(id, s)
      if (sessions.size > 500) sessions.delete(sessions.keys().next().value!)
    }
    return s
  }
  return {
    event(e: { type: string; properties: Record<string, unknown> }) {
      if (e.type === "message.updated") {
        const info = e.properties.info as Message["info"] | undefined
        if (!info?.sessionID || !info.id) return
        const s = get(info.sessionID)
        if (info.role === "user" && !s.users.includes(info.id)) s.users = [...s.users.slice(-7), info.id]
        if (info.role === "assistant" && !info.summary && info.finish) s.answer = { parentID: info.parentID, finish: info.finish }
      } else if (e.type === "message.part.updated") {
        const part = e.properties.part as (Part & { sessionID?: string }) | undefined
        if (part?.type === "compaction" && part.sessionID && part.messageID) get(part.sessionID).compactions.add(part.messageID)
      }
    },
    answered(sessionID: string): boolean {
      const s = sessions.get(sessionID)
      if (!s?.answer) return false
      const lastUser = [...s.users].reverse().find((id) => !s.compactions.has(id))
      return !!lastUser && s.answer.parentID === lastUser && !["tool-calls", "unknown", "error", "length"].includes(s.answer.finish)
    },
  }
}

function websearchDefinition(year: number) {
  return {
    description: [
      "- Search the web. Returns up to 5 results, each with its title, URL and the passages most relevant to the query.",
      "- Use it for current information beyond your knowledge cutoff. Use webfetch on a result's URL to read the full page.",
      `- The current year is ${year}. Use this year when searching for recent information or current events.`,
      "",
    ].join("\n"),
    jsonSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: { type: "string", description: "Websearch query" },
        numResults: { type: "number", description: `Number of search results to return (default: ${HYGIENE.numResults}, at most ${HYGIENE.maxNumResults})` },
      },
      required: ["query"],
    },
  }
}

/**
 * Q2: web results stop flooding the context. On unless SYRUP_CONTEXT_HYGIENE=0. Touches websearch
 * and webfetch only; coding tools (bash, read, grep, glob…) are left to OpenCode (QUALITY.md §3).
 */
const contextHygiene: Feature = (env) => {
  if (env.SYRUP_CONTEXT_HYGIENE === "0") return null
  const definition = websearchDefinition(new Date().getFullYear())
  const tracker = compactionTracker()
  return {
    "tool.definition": async (input, output) => {
      if (input.toolID !== "websearch") return
      output.description = definition.description
      output.jsonSchema = definition.jsonSchema
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "websearch" || !output.args || typeof output.args !== "object") return
      const n = Number(output.args.numResults)
      output.args.numResults = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), HYGIENE.maxNumResults) : HYGIENE.numResults
    },
    "tool.execute.after": async (input, output) => {
      if (!WEB_TOOLS.has(input.tool) || typeof output.output !== "string") return
      const raw = output.output
      let r: { text: string; mode: string }
      try {
        r = input.tool === "websearch" ? trimSearch(raw, String((input.args as { query?: unknown } | undefined)?.query ?? "")) : trimFetch(raw)
      } catch {
        // Never lose a result to a trimmer bug: the plain cut.
        r = { text: raw.length > HYGIENE.hard ? cutKeepingTables(raw, HYGIENE.hard) : raw, mode: "cut" }
      }
      output.output = r.text
      output.metadata = { ...output.metadata, rawChars: raw.length, keptChars: r.text.length, trim: r.mode }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (Array.isArray(output?.messages)) maskWebResults(output.messages)
    },
    "experimental.compaction.autocontinue": async (input, output) => {
      if (!input.overflow && tracker.answered(input.sessionID)) output.enabled = false
    },
    event: async ({ event }) => tracker.event(event),
  }
}

// ---------------------------------------------------------------- composition

/** In order; a later feature's tool with the same name wins, and hooks of the same name run one after another. */
const FEATURES: Feature[] = [evalReplay, contextHygiene]

function compose(list: Hooks[]): Hooks {
  const out: Hooks = {}
  const chains = new Map<string, ((a: never, b: never) => Promise<void>)[]>()
  for (const h of list) {
    for (const [k, v] of Object.entries(h)) {
      if (k === "tool") out.tool = { ...out.tool, ...(v as Record<string, ToolDef>) }
      else if (typeof v === "function") chains.set(k, [...(chains.get(k) ?? []), v as (a: never, b: never) => Promise<void>])
    }
  }
  const o = out as Record<string, unknown>
  for (const [k, fns] of chains)
    o[k] = async (a: never, b: never) => {
      for (const f of fns) await f(a, b)
    }
  return out
}

export const SyrupPlugin = async (): Promise<Hooks> => compose(FEATURES.map((f) => f(process.env)).filter((h): h is Hooks => h !== null))
