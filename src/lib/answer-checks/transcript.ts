/**
 * Reads an exported chat (syrup.transcript v1) back into messages, tools and metadata, from either
 * form src/lib/transcript.ts writes: the Markdown (share link /md, `pnpm chat:export`) or the JSON
 * (share /json, `pnpm chat:export --json`, with or without the --debug wrapper).
 *
 * Markdown layout it relies on (renderMarkdown): "## N. User · <utc>" / "## N. Assistant · <label> · <utc>"
 * headings, an italic facts line under each assistant heading, "### Tool: name · status · dur"
 * blocks with Title/Call/Input/Output/Error/Diff/Attachments, "### Thinking" quote blocks, and
 * fences that are always longer than any backtick run inside them.
 */

export type ParsedTool = {
  tool: string
  status: string
  title?: string
  /** The input object (JSON), or the raw text when it doesn't parse. */
  input: unknown
  output?: string
  error?: string
}

export type MessageMeta = {
  tookMs?: number
  ttftMs?: number
  /** Total tokens (input + output + reasoning). From the Markdown this is the rounded figure ("65k"). */
  tokens?: number
  /** Input tokens (incl. cache), JSON only. */
  inputTokens?: number
  cost?: number
  agent?: string
  finish?: string
  unfinished?: boolean
  error?: string
  router?: string
}

export type ParsedMessage = {
  /** The "## N." number: 1-based position in the chat. */
  index: number
  role: "user" | "assistant"
  /** "Auto → Gemini 3.5 Flash Lite (Google)". */
  label?: string
  /** "2026-10-08 10:25:43 UTC" or epoch ms as ISO. */
  at?: string
  /** What the user typed, or the assistant's answer: its text parts joined. */
  text: string
  /** Attached context the user message carried (file contents). */
  context: string[]
  reasoning: string
  tools: ParsedTool[]
  meta: MessageMeta
}

export type Turn = { index: number; user: ParsedMessage | null; assistants: ParsedMessage[] }

export type ParsedTranscript = {
  form: "markdown" | "json"
  title: string
  models: string[]
  messages: ParsedMessage[]
  /** One per user message (plus a leading one when the chat starts with an assistant message). */
  turns: Turn[]
}

// ------------------------------------------------------------------ shared

function turnsOf(messages: ParsedMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === "user" || !turns.length) turns.push({ index: turns.length + 1, user: m.role === "user" ? m : null, assistants: [] })
    if (m.role === "assistant") turns[turns.length - 1].assistants.push(m)
  }
  return turns
}

/** "908ms" → 908, "1.7s" → 1700, "1m" → 60000. */
export function parseDuration(s: string): number | undefined {
  const m = /^([\d.]+)\s*(ms|s|m)$/.exec(s.trim())
  if (!m) return undefined
  const v = Number(m[1])
  return Math.round(m[2] === "ms" ? v : m[2] === "s" ? v * 1000 : v * 60_000)
}

/** "6.9k" → 6900, "1.20M" → 1200000, "812" → 812. */
export function parseTokenCount(s: string): number | undefined {
  const m = /^([\d.]+)\s*([kM]?)$/.exec(s.trim())
  if (!m) return undefined
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "M" ? 1e6 : 1))
}

function factsOf(line: string): MessageMeta {
  const meta: MessageMeta = {}
  for (const bit of line.split(" · ")) {
    const b = bit.trim()
    let m: RegExpExecArray | null
    if (b === "unfinished") meta.unfinished = true
    else if ((m = /^took (.+)$/.exec(b))) meta.tookMs = parseDuration(m[1])
    else if ((m = /^(.+) to first token$/.exec(b))) meta.ttftMs = parseDuration(m[1])
    else if ((m = /^(.+) tokens$/.exec(b))) meta.tokens = parseTokenCount(m[1])
    else if ((m = /^\$([\d.]+)$/.exec(b))) meta.cost = Number(m[1])
    else if ((m = /^agent (.+)$/.exec(b))) meta.agent = m[1]
    else if ((m = /^finish (.+)$/.exec(b))) meta.finish = m[1]
  }
  return meta
}

// ------------------------------------------------------------------ Markdown

const HEADING = /^## (\d+)\. (User|Assistant)(?: · (.+?))? · (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC|unknown time)$/
const TOOL = /^### Tool: (.+?) · (pending|running|completed|error)(?: · .+)?$/
const THINKING = /^### Thinking(?: \(.+\))?$/
const OPEN_FENCE = /^(`{3,})([\w-]*)$/
const FOOTER = /^_Shared from syrup, .*_$/

/** Reads a fence that opens at lines[i]: returns its content and the index after the closing fence. */
function readFence(lines: string[], i: number): { content: string; next: number } | null {
  const m = OPEN_FENCE.exec(lines[i] ?? "")
  if (!m) return null
  const close = m[1]
  for (let j = i + 1; j < lines.length; j++) if (lines[j] === close) return { content: lines.slice(i + 1, j).join("\n"), next: j + 1 }
  return { content: lines.slice(i + 1).join("\n"), next: lines.length }
}

const skipBlank = (lines: string[], i: number) => {
  while (i < lines.length && !lines[i].trim()) i++
  return i
}

function parseMarkdown(src: string): ParsedTranscript {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  // A debug export puts the router timeline first; the transcript starts at its "# title" + "> Shared from syrup".
  let start = 0
  for (let i = 0; i + 2 < lines.length; i++)
    if (/^# /.test(lines[i]) && /^> (?:Shared from syrup|Format: syrup\.transcript)/.test(lines[i + 2] ?? "")) {
      start = i
      break
    }
  const title = (lines[start] ?? "").replace(/^# /, "").trim()
  const modelsLine = lines.slice(start, start + 12).find((l) => l.startsWith("> Models: "))
  const models = modelsLine ? modelsLine.slice("> Models: ".length).split(", ") : []

  const messages: ParsedMessage[] = []
  let cur: ParsedMessage | null = null
  let textBuf: string[] = []
  let inAnswerFence: { ch: string; len: number } | null = null
  const flushText = () => {
    if (cur && textBuf.length) cur.text = cur.text ? `${cur.text}\n\n${textBuf.join("\n").trim()}` : textBuf.join("\n").trim()
    textBuf = []
  }

  let i = start
  while (i < lines.length) {
    const line = lines[i]
    // Inside a fence the answer itself opened (and closes): everything is answer text, even a heading lookalike.
    if (inAnswerFence) {
      textBuf.push(line)
      const f = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (f && f[1][0] === inAnswerFence.ch && f[1].length >= inAnswerFence.len) inAnswerFence = null
      i++
      continue
    }
    const h = HEADING.exec(line)
    // A message heading is trusted only with the next number, so text that merely looks like one isn't.
    if (h && Number(h[1]) === messages.length + 1) {
      flushText()
      inAnswerFence = null
      cur = { index: Number(h[1]), role: h[2] === "User" ? "user" : "assistant", ...(h[3] && { label: h[3] }), at: h[4], text: "", context: [], reasoning: "", tools: [], meta: {} }
      messages.push(cur)
      i++
      if (cur.role === "assistant") {
        i = skipBlank(lines, i)
        const f = /^_(.+)_$/.exec(lines[i] ?? "")
        if (f && (/^took /.test(f[1]) || /^unfinished/.test(f[1]))) {
          cur.meta = factsOf(f[1])
          i++
        }
        i = skipBlank(lines, i)
        const r = /^_Router: (.+)\._$/.exec(lines[i] ?? "")
        if (r) {
          cur.meta.router = r[1]
          i++
        }
        i = skipBlank(lines, i)
        if (lines[i] === "Router requests:") {
          i = skipBlank(lines, i + 1)
          while (i < lines.length && lines[i].startsWith("- ")) i++
        }
      }
      continue
    }
    if (!cur) {
      i++
      continue
    }
    if (cur.role === "assistant" && TOOL.test(line)) {
      flushText()
      const m = TOOL.exec(line) as RegExpExecArray
      const tool: ParsedTool = { tool: m[1], status: m[2], input: {} }
      cur.tools.push(tool)
      i++
      for (;;) {
        i = skipBlank(lines, i)
        const l = lines[i] ?? ""
        if (l.startsWith("Title: ")) {
          tool.title = l.slice(7)
          i++
        } else if (/^Call: `.*`$/.test(l)) i++
        else if (l === "Input:" || l === "Output:" || l === "Error:" || l === "Diff:") {
          const f = readFence(lines, skipBlank(lines, i + 1))
          if (!f) break
          if (l === "Input:") {
            try {
              tool.input = JSON.parse(f.content)
            } catch {
              tool.input = f.content
            }
          } else if (l === "Output:") tool.output = f.content === "(empty)" ? "" : f.content
          else if (l === "Error:") tool.error = f.content === "(empty)" ? "" : f.content
          i = f.next
        } else if (l === "Attachments:") {
          i = skipBlank(lines, i + 1)
          while (i < lines.length && lines[i].startsWith("- ")) i++
        } else break
      }
      continue
    }
    if (cur.role === "assistant" && THINKING.test(line)) {
      flushText()
      i = skipBlank(lines, i + 1)
      const quoted: string[] = []
      while (i < lines.length && (lines[i] === ">" || lines[i].startsWith("> "))) quoted.push(lines[i++].replace(/^> ?/, ""))
      cur.reasoning = cur.reasoning ? `${cur.reasoning}\n\n${quoted.join("\n")}` : quoted.join("\n")
      continue
    }
    if (line === "Attachment:" || line === "Attachments:" || line === "### Edited files") {
      flushText()
      i = skipBlank(lines, i + 1)
      while (i < lines.length && lines[i].startsWith("- ")) i++
      continue
    }
    if (cur.role === "user" && line === "Attached context:") {
      flushText()
      const f = readFence(lines, skipBlank(lines, i + 1))
      if (f) {
        cur.context.push(f.content)
        i = f.next
        continue
      }
    }
    if (cur.role === "assistant" && /^### Subagent(?:: .+)?$/.test(line)) {
      flushText()
      i++
      // description line, then an optional prompt fence
      i = skipBlank(lines, i)
      if (i < lines.length && !OPEN_FENCE.test(lines[i]) && !HEADING.test(lines[i])) i++
      const f = readFence(lines, skipBlank(lines, i))
      if (f) i = f.next
      continue
    }
    if (cur.role === "assistant" && (/^_Retry .*_$/.test(line) || line === "_Context compacted._")) {
      i++
      continue
    }
    // The message's own error: "Error:" + a fence, then the next message or the footer.
    if (cur.role === "assistant" && line === "Error:") {
      const f = readFence(lines, skipBlank(lines, i + 1))
      if (f) {
        const after = skipBlank(lines, f.next)
        if (after >= lines.length || HEADING.test(lines[after]) || lines[after] === "---") {
          flushText()
          cur.meta.error = f.content
          i = f.next
          continue
        }
      }
    }
    const fo = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fo && !(fo[1][0] === "`" && fo[2].includes("`"))) {
      // An answer cut off mid-stream can leave its fence open; only a fence that closes hides headings.
      const fence = { ch: fo[1][0], len: fo[1].length }
      const closes = lines.slice(i + 1).some((l) => {
        const f = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l)
        return !!f && f[1][0] === fence.ch && f[1].length >= fence.len
      })
      if (closes) inAnswerFence = fence
    }
    textBuf.push(line)
    i++
  }
  flushText()
  // The export's closing rule and footer belong to no message.
  const last = messages[messages.length - 1]
  if (last) last.text = last.text.replace(/\n*---\n+_Shared from syrup, [^\n]*_\s*$/, "").replace(/\n*---\s*$/, "").trim()
  for (const m of messages) m.text = m.text.split("\n").filter((l) => !FOOTER.test(l)).join("\n").trim()
  return { form: "markdown", title, models, messages, turns: turnsOf(messages) }
}

// ------------------------------------------------------------------ JSON

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown) => (typeof v === "string" ? v : undefined)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

function parseJson(data: Obj): ParsedTranscript {
  // `pnpm chat:export --json --debug` and the owner's debug link wrap the transcript; the CLI bundle has { transcript }.
  const t = data.format === "syrup.transcript" ? data : obj(data.transcript)
  if (t.format !== "syrup.transcript") throw new Error("not a syrup.transcript export (format field missing)")
  const raw = Array.isArray(t.messages) ? t.messages : []
  const messages: ParsedMessage[] = raw.map((rm, k) => {
    const m = obj(rm)
    const role = m.role === "user" ? "user" : "assistant"
    const parts = Array.isArray(m.parts) ? m.parts.map(obj) : []
    const text = parts
      .filter((p) => p.type === "text" && !p.synthetic && str(p.text))
      .map((p) => (str(p.text) as string).trim())
      .filter(Boolean)
      .join("\n\n")
    const context = parts.filter((p) => p.type === "text" && p.synthetic && str(p.text)).map((p) => str(p.text) as string)
    const reasoning = parts
      .filter((p) => p.type === "reasoning" && str(p.text))
      .map((p) => str(p.text) as string)
      .join("\n\n")
    const tools: ParsedTool[] = parts
      .filter((p) => p.type === "tool")
      .map((p) => ({ tool: str(p.tool) ?? "tool", status: str(p.status) ?? "pending", ...(str(p.title) && { title: str(p.title) }), input: p.input ?? {}, ...(str(p.output) !== undefined && { output: str(p.output) }), ...(str(p.error) !== undefined && { error: str(p.error) }) }))
    const meta: MessageMeta = {}
    const created = num(m.createdAt)
    const completed = num(m.completedAt)
    if (role === "assistant") {
      if (created && completed) meta.tookMs = completed - created
      else meta.unfinished = true
      const routed = Array.isArray(m.routed) ? m.routed.map(obj) : []
      const final = routed[routed.length - 1]
      if (final && num(final.ttftMs) !== undefined) meta.ttftMs = num(final.ttftMs)
      const tk = obj(m.tokens)
      if (Object.keys(tk).length) {
        meta.tokens = (num(tk.input) ?? 0) + (num(tk.output) ?? 0) + (num(tk.reasoning) ?? 0)
        meta.inputTokens = (num(tk.input) ?? 0) + (num(tk.cacheRead) ?? 0) + (num(tk.cacheWrite) ?? 0)
      }
      if (num(m.cost) !== undefined) meta.cost = num(m.cost)
      if (str(m.agent)) meta.agent = str(m.agent)
      if (str(m.finish)) meta.finish = str(m.finish)
      if (str(m.error)) meta.error = str(m.error)
      if (str(m.switchNote)) meta.router = str(m.switchNote)
    }
    return {
      index: k + 1,
      role,
      ...(str(m.modelLabel) && { label: str(m.modelLabel) }),
      ...(created && { at: new Date(created).toISOString() }),
      text,
      context,
      reasoning,
      tools,
      meta,
    }
  })
  return { form: "json", title: str(t.title) ?? "", models: Array.isArray(t.models) ? t.models.filter((x): x is string => typeof x === "string") : [], messages, turns: turnsOf(messages) }
}

/** Parses either export form. Throws when the text is neither. */
export function parseTranscript(src: string): ParsedTranscript {
  const s = src.replace(/^\uFEFF/, "")
  if (/^\s*\{/.test(s)) return parseJson(obj(JSON.parse(s)))
  const t = parseMarkdown(s)
  if (!t.messages.length) throw new Error("no messages found: expected a syrup.transcript export (## 1. User · … headings)")
  return t
}
