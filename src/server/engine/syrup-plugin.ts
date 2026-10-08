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
 *   - Q2 context hooks and the Q4 webfetch override join FEATURES below.
 * With every feature off the plugin returns no hooks at all, so the engine (tools, prompts,
 * requests) is exactly what it is without the plugin.
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
type Hooks = { tool?: Record<string, ToolDef>; "tool.definition"?: DefinitionHook }
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

// ---------------------------------------------------------------- composition

/** In order; a later feature's tool with the same name wins, and hooks of the same name run one after another. */
const FEATURES: Feature[] = [evalReplay]

function compose(list: Hooks[]): Hooks {
  const out: Hooks = {}
  const defs: DefinitionHook[] = []
  for (const h of list) {
    if (h.tool) out.tool = { ...out.tool, ...h.tool }
    if (h["tool.definition"]) defs.push(h["tool.definition"])
  }
  if (defs.length)
    out["tool.definition"] = async (input, output) => {
      for (const d of defs) await d(input, output)
    }
  return out
}

export const SyrupPlugin = async (): Promise<Hooks> => compose(FEATURES.map((f) => f(process.env)).filter((h): h is Hooks => h !== null))
