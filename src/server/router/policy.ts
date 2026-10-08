import { costTier, type Grade } from "../../lib/model-registry"
import type { Alias, Candidate } from "./backends"
import type { Health } from "./health"
import type { SessionState } from "./sessions"

/**
 * Per-request routing policy: how big the request is, whether the turn is
 * hard, which candidates can take it at all (feasibility), and in which order
 * to try the rest (scoring + stickiness). Cheap heuristics only, no LLM calls.
 * Deterministic for a given state.
 */

type Part = { type?: string; text?: unknown; image_url?: { url?: string } | string; url?: string }
export type Msg = { role?: string; content?: unknown; tool_calls?: unknown[] }

export type RequestShape = {
  alias: Alias
  promptTokens: number
  /** Output tokens the caller allows (max_completion_tokens ?? max_tokens ?? 8192), capped on a title call (core.ts). */
  requestedOut: number
  hasImage: boolean
  hard: boolean
  hardWhy: string | null
  /** The last message is the user's (a new turn, not a tool-call continuation). */
  lastIsUser: boolean
  /** The chat's very first turn: one user message, nothing answered yet. Nothing is cached and the screen is blank. */
  opening: boolean
  /**
   * The latest user message asks for a number: arithmetic, a conversion, an estimate, a price comparison (isNumeric).
   * Auto only. Lowers the scarcity penalty and lets a user turn move to a stronger free model that is nearly as fast
   * (applySticky); core.ts may also ask a minimal-thinking model to think (RouterOptions.numericEffort, off by default).
   */
  numeric?: boolean
  /**
   * Keep off scarce free backends entirely (Gemini Flash, OpenRouter's daily cap, any free tier with ≤ 60 requests a day):
   * set for eval traffic (`x-syrup-eval: 1`, docs/QUALITY.md §7 decision 4), so `pnpm eval` never eats the user's daily quota.
   */
  offScarce?: boolean
}

/** Request header an eval engine sends on every model request (engine/opencode.ts EVAL_HEADER). */
export const EVAL_HEADER = "x-syrup-eval"

/** True for the first request of a chat: exactly one user message and no assistant message yet. */
export function isOpening(messages: Msg[]): boolean {
  let users = 0
  for (const m of messages) {
    if (m.role === "assistant" || m.role === "tool") return false
    if (m.role === "user") users++
  }
  return users === 1
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p: Part) => (typeof p?.text === "string" ? p.text : "")).join("\n")
  return ""
}

const IMAGE_TYPES = new Set(["image_url", "input_image", "image"])

function images(messages: Msg[]): { count: number; dataChars: number } {
  let count = 0
  let dataChars = 0
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content as Part[]) {
      if (!p || !IMAGE_TYPES.has(String(p.type))) continue
      count++
      const url = typeof p.image_url === "string" ? p.image_url : (p.image_url?.url ?? p.url)
      if (typeof url === "string" && url.startsWith("data:")) dataChars += url.length
    }
  }
  return { count, dataChars }
}

/**
 * Prompt size estimate from the raw request body: ~3.6 characters per token,
 * with inline images counted as ~1K tokens each instead of their base64 size.
 */
export function estimatePromptTokens(rawLength: number, messages: Msg[]): { tokens: number; hasImage: boolean } {
  const img = images(messages)
  return { tokens: Math.ceil(Math.max(0, rawLength - img.dataChars) / 3.6) + img.count * 1000, hasImage: img.count > 0 }
}

// ---------------------------------------------------------------- turn difficulty

const HARD_RE = /\b(plan|architect|design|debug|root cause|refactor|investigate|think (hard|deeply)|why (is|does|did))\b/i
/**
 * A tool result that opens with an error report. OpenCode sends a failed
 * call's error text as the whole result ("Error: …"); a successful read,
 * grep or build log that merely mentions errors further in does not count.
 */
const TOOL_FAIL_RE = /^(?:[\w.$]*(?:error|exception)(?:\[[^\]\n]*\])?:|traceback \(most recent call last\)|fatal:|panic:|npm err!|enoent\b|[^\n]{0,120}: (?:command not found|not found$|no such file or directory))/i
const ESCALATE_MS = 10 * 60_000

/** Failing tool results at the end of the conversation, counted back to the first success or user message. */
export function trailingToolFailures(messages: Msg[]): number {
  let n = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" || m.role === "system") break
    if (m.role !== "tool") continue
    if (TOOL_FAIL_RE.test(firstLine(textOf(m.content)))) n++
    else break
  }
  return n
}

function firstLine(text: string): string {
  const t = text.trimStart().slice(0, 300)
  const nl = t.indexOf("\n")
  return nl < 0 ? t : t.slice(0, nl)
}

// Signals that a request is substantial work, not a quick answer. Two or more make the turn hard.
const DEPTH_RE = /\b(detailed|in[- ]depth|comprehensive|thorough|complete|entire|whole|full[- ]?(?:blown|scale)?|end[- ]to[- ]end|step[- ]by[- ]step|from scratch|production[- ]ready)\b/i
const WORK_RE = /\b(build|create|implement|write|draft|develop|generate|research|analy[sz]e|compare|strategy|campaign|migrate|optimi[sz]e|document)\b/i
const LONG_ASK_CHARS = 600

/** Why a request reads as substantial: long, asks for depth, asks to produce something, or has several parts. */
function workSignals(text: string): string[] {
  const out: string[] = []
  if (text.length >= LONG_ASK_CHARS) out.push("long")
  if (DEPTH_RE.test(text)) out.push("depth")
  if (WORK_RE.test(text)) out.push("work")
  const items = text.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm)?.length ?? 0
  const questions = text.match(/\?/g)?.length ?? 0
  if (items >= 3 || questions >= 3) out.push("multi_part")
  return out
}

function userMessages(messages: Msg[]): number {
  let n = 0
  for (const m of messages) if (m.role === "user") n++
  return n
}

/**
 * Judged from the latest user message, so every step of a turn (tool calls, a continuation after a cut-off)
 * shares its verdict. Hard for planning/debugging-type asks, for substantial work (two or more work signals),
 * or while the session keeps failing tool calls (then for ESCALATE_MS). Auto only.
 *
 * Answer fast, escalate after (decision 13): a hard opening turn is answered by the quickest adequate model (rank),
 * so it escalates its session by turns, not by the clock: the opening turn's own tool-call steps (their latest user
 * message is still the hard one) and the whole next user turn are hard, even when that reply reads as routine
 * ("ok, do it") and however long the user took to write it. The user turn after that is judged on its own again.
 * The session's 30-minute idle expiry (sessions.ts) bounds it. applySticky then moves the chat to the strongest grade
 * on offer and keeps it there.
 */
export function difficulty(alias: Alias, messages: Msg[], session: SessionState, now: number): { hard: boolean; why: string | null } {
  if (alias !== "auto") return { hard: false, why: null }
  const failures = trailingToolFailures(messages)
  if (failures >= 2) session.escalatedUntil = now + ESCALATE_MS
  const users = userMessages(messages)
  // A later user turn has begun: the opening's escalation is over (cleared, so a compacted history cannot revive it).
  if (session.escalatedThroughUser > 0 && users > session.escalatedThroughUser) session.escalatedThroughUser = 0
  const verdict = askVerdict(messages) ?? (failures >= 2 ? { hard: true, why: `tool_failures:${failures}` } : null)
  if (verdict && isOpening(messages)) session.escalatedThroughUser = users + 1
  if (verdict) return verdict
  if (session.escalatedUntil > now || (session.escalatedThroughUser > 0 && users <= session.escalatedThroughUser)) return { hard: true, why: "escalated" }
  return { hard: false, why: null }
}

/** Words before "plan" that make it a product's plan: "a pricing plan", "the cheapest plan", "which plan". */
const PLAN_NOUN_BEFORE = /(?:^|[^\w])(?:pricing|price|paid|free|pro|basic|starter|premium|plus|team|business|enterprise|family|monthly|annual|yearly|data|phone|mobile|subscription|hosting|cheaper|cheapest|which)\s+$/i
/** A named plan: "the Pro plan", "the Team plan". Case-sensitive, so "the migration plan" is still planning work. */
const PLAN_NAMED_BEFORE = /(?:^|[^\w])the [A-Z][\w-]*\s+$/
/** What may follow a plan that is a noun: a letter or number naming it ("plan A", "plan 2"; case-sensitive, so "plan a migration" stays a verb), or a price word. */
const PLAN_NOUN_AFTER = /^(?:\s+[A-Z0-9]\b(?![a-z])|(?:'s|s)?\s+(?:costs?|start|starts|includes?|tiers?|prices?|pricing)\b)/

/**
 * "plan" as a noun ("plan A or plan B", "the Pro plan's price"), judged per occurrence, so a comparison of plans is not
 * a planning task. A message that starts with "Plan" is always the verb ("Plan the auth module").
 */
function planIsNoun(text: string, at: number): boolean {
  if (/^\s*$/.test(text.slice(0, at))) return false
  const before = text.slice(Math.max(0, at - 40), at)
  return PLAN_NOUN_BEFORE.test(before) || PLAN_NAMED_BEFORE.test(before) || PLAN_NOUN_AFTER.test(text.slice(at + 4, at + 40))
}

const HARD_ALL_RE = new RegExp(HARD_RE.source, "gi")

/** Hard because of what the latest user message asks (a keyword, or two or more work signals); null when it reads as routine. */
function askVerdict(messages: Msg[]): { hard: true; why: string } | null {
  const text = latestUserText(messages)
  if (text === null) return null
  for (const m of text.matchAll(HARD_ALL_RE)) {
    const word = m[1].toLowerCase()
    if (word === "plan" && planIsNoun(text, m.index)) continue
    return { hard: true, why: `keyword:${word}` }
  }
  const signals = workSignals(text)
  return signals.length >= 2 ? { hard: true, why: `work:${signals.join("+")}` } : null
}

/** The latest user message's text (its first 20,000 characters), or null when there is none. */
function latestUserText(messages: Msg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return textOf(messages[i].content).slice(0, 20_000)
  return null
}

// ---------------------------------------------------------------- numeric turns

/** Words that ask for a quantity. */
const QUANT_RE = /\b(estimat\w*|approx\w*|calculat\w*|compute|convert\w*|conversion|total|sum|add (?:it |them )?up|how (?:much|many)|average|median|percent(?:age)?|ratio|per (?:month|year|day|hour|user|seat|unit|gb|tb|token|request)|cost|price|pricing|budget|revenue|margin|roi|break[- ]even|exchange rate|cheaper|more expensive|forecast|projection)\b/i
/** Money, a currency or a quantity with a unit. */
const MONEY_UNIT_RE = /[$€£¥₹]\s?\d|\d[\d,.]*\s?(?:%|k\b|m\b|bn\b|usd|eur|gbp|pkr|inr|jpy|cny|aed|cad|aud|gb|tb|kg|km|hrs?|hours?|days?|months?|years?|seats?|users?|tokens?)\b|\b(?:usd|eur|gbp|pkr|inr|jpy|cny|aed|cad|aud)\b/i
/** A short follow-up that only names a currency: "in PKR", "and in euros?" (the K2 chat's last turn). */
const CURRENCY_FOLLOWUP_RE = /^\W*(?:and |what about |now )?(?:in|to|into) (?:usd|eur|gbp|pkr|inr|jpy|cny|aed|cad|aud|dollars?|euros?|pounds?|rupees?|yen|dirhams?)\W*$/i
/**
 * Arithmetic written out: "15% of 2.4M", "3 x 25", "1200/12". A division must stand alone, so a path ("logs/2024/01")
 * is not one, and "0x1F" is hex. A date ("10/08") still matches; that only costs a little.
 */
const ARITH_RE = /\d[\d,.]*\s?%\s+of\b|(?<![\w.\/])(?!0x)\d[\d,.]*\s*(?:[×*+\/]|x(?=\s*\d))\s*\d[\d,.]*(?![\w\/])/i

/**
 * A turn whose answer is a number: arithmetic, a conversion, an estimate, a price comparison. Cheap and deliberately
 * loose: a false positive costs a few seconds at most (scarcity −10 instead of −25, or a model about as fast); a miss
 * leaves today's routing. Catches the K2 chat's own numberless follow-ups ("approx cost", "in PKR"); misses others
 * ("what did it cost them in total?").
 */
export function isNumeric(text: string): boolean {
  if (ARITH_RE.test(text) || CURRENCY_FOLLOWUP_RE.test(text)) return true
  if (!QUANT_RE.test(text)) return false
  const numbers = text.match(/\d[\d,.]*/g)?.length ?? 0
  return MONEY_UNIT_RE.test(text) || numbers >= 2 || /\b(?:estimat|approx|convert|how much)\w*/i.test(text)
}

/** Whether the latest user message asks for a number. Auto only; judged like askVerdict, so every step of the turn shares it. */
export function numericTurn(alias: Alias, messages: Msg[]): boolean {
  if (alias !== "auto") return false
  const text = latestUserText(messages)
  return text !== null && isNumeric(text)
}

// ---------------------------------------------------------------- title calls

/** The first line of OpenCode's title prompt (its hidden "title" agent, title.txt) and the fixed ask sent after it (session/prompt.ts). */
const TITLE_SYSTEM = "You are a title generator. You output ONLY a thread title. Nothing else."
const TITLE_ASK = "Generate a title for this conversation:"

/**
 * OpenCode's chat-title call: the title prompt as the system message, then the fixed ask, then the chat's first user
 * message, no tools. It is the only call OpenCode makes to its small model (syrup/fast) in a chat, once per chat, on a
 * fiber of its own that the turn never waits on. Recognised by both fixed texts, not by size: a title carries the whole
 * first message (a pasted log or an attached file makes it large), and a compaction of a short chat on Fast is small
 * and tool-less too, but it is part of the turn. If OpenCode ever changes either text, the call simply routes normally.
 */
export function isTitleCall(messages: Msg[], tools: unknown): boolean {
  const hasTools = Array.isArray(tools) ? tools.length > 0 : tools != null
  if (hasTools) return false
  const [system, ask] = messages
  return system?.role === "system" && textOf(system.content).startsWith(TITLE_SYSTEM) && ask?.role === "user" && textOf(ask.content).trim() === TITLE_ASK
}

/** OpenCode's own limit for a title is 100 characters; its title prompt asks for at most 50. */
const FALLBACK_TITLE_MAX = 50
/** The title when the first message has no usable text (an image or a file alone). */
export const FALLBACK_TITLE_EMPTY = "New chat"

/** One line of the user's message as plain text: markdown markers dropped, whitespace collapsed; "" when nothing is left. */
function plainLine(line: string): string {
  const s = line
    .replace(/^\s*(?:>\s?)+/, "") // blockquote
    .replace(/^\s*#{1,6}\s+/, "") // heading
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "") // list item
    .replace(/^\[[ xX]\]\s+/, "") // task box
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image: its alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link: its text
    .replace(/`+([^`]*)`+/g, "$1") // inline code
    // bold, strikethrough — only at word edges, so 2**10 survives; __name__ around one identifier is Python, kept as written
    .replace(/(^|[^\w*~])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\2(?![\w*~])/g, (all, pre, mark, inner) => (mark === "__" && /^\w+$/.test(inner) ? all : `${pre}${inner}`))
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1$2") // *emphasis*
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2") // _emphasis_, never snake_case
    .replace(/\s+/g, " ") // first, so a tab between words becomes a space rather than being dropped below
    .replace(/[\p{Cc}\p{Cf}]/gu, "") // control and format characters: ANSI escapes, zero-width, direction overrides
    .replace(/ {2,}/g, " ")
    .trim()
  // Something a person can read must be left: a letter or a digit.
  return MARKUP_ONLY.test(s) || !/[\p{L}\p{N}]/u.test(s) ? "" : s
}

/** A rule, a table separator or a line of nothing but markup. */
const MARKUP_ONLY = /^[-*_=~#>|`:+\s]*$/

/** At most `max` characters (code points), cut at a word boundary with an ellipsis when it does not fit. */
function fitTitle(s: string, max: number): string {
  // Grapheme clusters, so a cut never splits a flag or a family emoji.
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (g) => g.segment)
  if (chars.length <= max) return s
  // Room for the ellipsis inside the limit.
  const room = chars.slice(0, max - 1)
  let end = room.length
  if (chars[max - 1] !== " ") {
    const space = room.lastIndexOf(" ")
    // A word boundary, unless it would throw away more than half (one long path or URL): then a hard cut.
    if (space >= max / 2) end = space
  }
  const head = room
    .slice(0, end)
    .join("")
    .replace(/[\s,.;:!?(\-–—]+$/, "")
  return `${head || room.join("")}…`
}

/**
 * How much of one line the markdown stripping sees. A title keeps 50 characters, and plainLine's regexes are
 * quadratic on markers that never close ("**a " or "[" repeated): uncapped, one 200 KB pasted line held the event loop
 * for about a minute, and in local mode the router shares the app's Node process.
 */
const TITLE_LINE_CAP = 1_000
/** Lines and characters of prose plainLine may look at before the title falls back to the code (a message of only markup). */
const TITLE_PROSE_LINES = 200
const TITLE_PROSE_CHARS = 20_000

/** The start of a line, without its leading whitespace, at most TITLE_LINE_CAP code units and never half a surrogate pair. */
function lineHead(line: string): string {
  const s = line.trimStart()
  if (s.length <= TITLE_LINE_CAP) return s
  const cut = /[\uD800-\uDBFF]/.test(s[TITLE_LINE_CAP - 1]) ? TITLE_LINE_CAP - 1 : TITLE_LINE_CAP
  return s.slice(0, cut)
}

const REMINDER_OPEN = "<system-reminder>"
const REMINDER_CLOSE = "</system-reminder>"

/** OpenCode's <system-reminder> blocks replaced by a line break, in one pass; an unclosed one is left as it is. */
function stripReminders(text: string): string {
  let out = ""
  let from = 0
  for (;;) {
    const open = text.indexOf(REMINDER_OPEN, from)
    if (open < 0) break
    const close = text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length)
    if (close < 0) break
    out += `${text.slice(from, open)}\n`
    from = close + REMINDER_CLOSE.length
  }
  return out + text.slice(from)
}

/**
 * The title the router answers with when it lets a title call go (decision 16, option e): made from the chat's first
 * user message, the title request's third message. Its first line that has text once code fences and markdown are
 * stripped, whitespace collapsed, cut at a word boundary to at most 50 characters with an ellipsis. A message that is
 * nothing but code gives the code's first line; one with no text at all (an image alone) gives "New chat". Never empty.
 * Linear in the message: one pass over its lines, and the regexes only ever see a bounded head of a few of them.
 */
export function fallbackTitle(messages: Msg[]): string {
  // OpenCode sends history up to the first user message with a real (non-synthetic) part, so that message comes LAST;
  // synthetic turns before it (a shell "!cmd") come first.
  const first = [...messages.slice(2)].reverse().find((m) => m?.role === "user")
  // OpenCode strips closed <think> blocks from a title, so a line made only of one would leave no title at all.
  const text = first ? stripReminders(textOf(first.content)).replace(/<think>[\s\S]{0,20000}?<\/think>/g, "\n") : ""
  let firstCode: string | null = null
  let lines = 0
  let chars = 0
  // The open fence ("```" or "~~~", three or more), or null outside one. An unclosed fence runs to the end.
  let fence: string | null = null
  for (let from = 0; from <= text.length; ) {
    let end = text.indexOf("\n", from)
    if (end < 0) end = text.length
    const raw = text.slice(from, end)
    from = end + 1
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    // A blank line is neither a fence nor text, in a code block or out of one.
    if (!line) continue
    const m =/^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null
      else if (firstCode === null) {
        const s = lineHead(line).replace(/\s+/g, " ").trim()
        if (s) firstCode = s
      }
      continue
    }
    if (m) {
      fence = m[1]
      continue
    }
    // Nothing but markup (a rule, a table separator): no text survives plainLine, so it costs no budget.
    if (MARKUP_ONLY.test(line)) continue
    if (lines >= TITLE_PROSE_LINES || chars >= TITLE_PROSE_CHARS) continue
    const head = lineHead(line)
    lines++
    chars += head.length
    const s = plainLine(head)
    if (s) return fitTitle(s, FALLBACK_TITLE_MAX)
  }
  return firstCode ? fitTitle(firstCode, FALLBACK_TITLE_MAX) : FALLBACK_TITLE_EMPTY
}

/** How much of a model's title answer is looked at for visible text; a title is one line of at most 100 characters. */
const TITLE_TEXT_CAP = 16_000

/** A title answer's text so far plus one more piece, kept to TITLE_TEXT_CAP. */
export function appendTitleText(sofar: string, piece: string): string {
  return sofar.length >= TITLE_TEXT_CAP ? sofar : sofar + piece.slice(0, TITLE_TEXT_CAP - sofar.length)
}

/**
 * Whether a model's title answer has a title in it: non-whitespace text once <think> blocks are dropped (an unclosed
 * one runs to the end), as OpenCode strips them before saving a title. Reasoning fields are never text: OpenCode keeps
 * only the answer's text, so a title that is all thinking leaves the chat named "New session - <timestamp>".
 */
export function hasTitleText(text: string): boolean {
  return /\S/.test(text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, ""))
}

// ---------------------------------------------------------------- feasibility

/** Smallest output budget worth sending when context or a TPM limit forces a clamp. */
const MIN_OUT_CONTEXT = 4096
const MIN_OUT_TPM = 1024

export type Exclusion = "vision" | "context" | "tpm" | "cooling" | "tokens_left" | "busy"

export type Fit = { ok: true; outTokens: number } | { ok: false; why: Exclusion; until?: number; coolReason?: string }

/** Hard limits that do not change within a request: images, context window, tokens-per-minute. */
export function staticFit(c: Candidate, shape: RequestShape, health: Health): Fit {
  if (shape.hasImage && !c.vision) return { ok: false, why: "vision" }
  const p = shape.promptTokens
  let out = Math.min(shape.requestedOut, c.maxOutput > 0 ? c.maxOutput : shape.requestedOut)
  if (c.tier === "free" && (c.providerID === "groq" || c.providerID === "cerebras")) out = Math.min(out, 8192)
  if (c.context > 0) {
    const room = Math.floor(c.context / 1.05) - p
    if (room < Math.min(out, MIN_OUT_CONTEXT)) return { ok: false, why: "context" }
    out = Math.min(out, room)
  }
  const learnedMax = health.learnedMaxPrompt(c)
  if (learnedMax !== undefined && p > learnedMax) return { ok: false, why: "context" }
  const tpm = Math.min(c.limits?.tpm ?? Infinity, health.learnedTpm(c) ?? Infinity)
  if (Number.isFinite(tpm)) {
    const room = tpm - p
    if (room < Math.min(out, MIN_OUT_TPM)) return { ok: false, why: "tpm" }
    out = Math.min(out, room)
  }
  return { ok: true, outTokens: Math.max(1, Math.floor(out)) }
}

/** Limits that change from moment to moment: cooldowns, per-minute token budget, one-at-a-time providers. */
export function dynamicBlock(c: Candidate, shape: RequestShape, outTokens: number, health: Health, now: number): Fit | null {
  const cool = health.coolingUntil(c)
  if (cool) return { ok: false, why: "cooling", until: cool.until, coolReason: cool.reason }
  const rem = health.remainingTokens(c)
  if (rem && rem.n < shape.promptTokens + Math.min(outTokens, MIN_OUT_TPM)) return { ok: false, why: "tokens_left", until: rem.until }
  if (c.serial && health.busy(c)) return { ok: false, why: "busy", until: now + 2000 }
  return null
}

// ---------------------------------------------------------------- scoring

export type Scored = {
  c: Candidate
  score: number
  predTtftMs: number
  predMs: number
  outTokens: number
  /** On an Auto opening turn: the model is below the turn's opening floor (openingFloor), so speed may not promote it. */
  belowFloor: boolean
}

const GRADE_RANK: Record<Grade, number> = { small: 0, mid: 1, strong: 2, frontier: 3 }

/** Quality a free model needs to be picked for its speed on a chat's routine opening turn. */
const OPENING_QUALITY_FLOOR = 60

/**
 * The fallback guardrail (docs/QUALITY.md Q5). On a routine later turn, a candidate predicted slower than both
 * SLOW_ABS_MS and SLOW_RATIO × the quickest adequate model (quality 55+, free first) loses SLOW_PENALTY: still in the
 * list for when nothing else can answer, never picked over a quick one. On 2026-10-08 a routine turn failed over to
 * a free 550B model that took ~57 s for a short table while a quick model was up.
 */
const SLOW_ABS_MS = 20_000
const SLOW_RATIO = 3
const SLOW_PENALTY = 30
/** Quality that counts as adequate for the guardrail's "quickest". */
const SLOW_ADEQUATE_QUALITY = OPENING_QUALITY_FLOOR - 5
/** A hard turn weighs time lightly, so a model predicted beyond this loses HARD_SLOW_PENALTY: quality alone never buys a 3-minute decoder. */
const HARD_SLOW_MS = 90_000
const HARD_SLOW_PENALTY = 15
/** Scarcity penalty on a routine turn, and on a numeric one (a stronger model is worth more there). */
const SCARCITY_ROUTINE = 25
const SCARCITY_NUMERIC = 10
/** Grade a free model needs to be picked for its speed on a hard opening turn: the registry's strong grade (quality 72+). */
const HARD_OPENING_GRADE: Grade = "strong"

/**
 * Which models count as adequate for an opening turn's speed pick. Routine turns: quality 60+. Hard turns: the strong
 * grade, or quality 60+ when no free model is strong. The free models set the floor; when none of them clears quality
 * 60, every candidate does (a paid-only key set keeps its floor too). Null (no floor) when nothing clears quality 60.
 */
function openingFloor(hard: boolean, pool: { c: Candidate }[]): ((c: Candidate) => boolean) | null {
  const strong = (c: Candidate) => GRADE_RANK[c.info.grade] >= GRADE_RANK[HARD_OPENING_GRADE]
  const routine = (c: Candidate) => c.info.quality >= OPENING_QUALITY_FLOOR
  for (const set of [pool.filter((f) => !f.c.costs), pool]) {
    if (hard && set.some((f) => strong(f.c))) return strong
    if (set.some((f) => routine(f.c))) return routine
  }
  return null
}

/**
 * Quality a free model needs for a paid key to be held back (free first): 70, or 84 on a hard turn. A request that is
 * hard only because its session is escalated uses the routine bar: the escalation buys a stronger grade among the
 * models the chat would use anyway, never a paid key that the request's own words would not have bought.
 */
function freeBar(shape: RequestShape): number {
  return shape.hard && shape.hardWhy !== "escalated" ? 84 : 70
}

/**
 * Free first: a paid key is held back when a good free model can take the request (freeBar), and on a hard opening
 * when a free model clears the opening floor: speed alone never buys a paid model.
 */
function paidHeldBack(shape: RequestShape, pool: readonly { c: Candidate }[], floor: ((c: Candidate) => boolean) | null): boolean {
  const bar = freeBar(shape)
  return pool.some((f) => !f.c.costs && (f.c.info.quality >= bar || (shape.hard && floor !== null && floor(f.c))))
}

/**
 * Orders feasible candidates, best first.
 * Auto: quality − time − risk − scarcity − paid, where time is cheap on hard turns and scarcity only applies to routine ones.
 * On a chat's opening turn, time means the predicted first token and weighs four times more: the user is looking at a
 * blank screen and nothing is cached yet, so the model that answers first wins among adequate ones (openingFloor). A
 * hard opening asks more of "adequate" and escalates its session for what follows (difficulty).
 * Fast: least predicted wall time (first token weighted double), quality floor 50.
 * Eval traffic (`offScarce`) never sees a scarce candidate at all, not even as a fallback.
 * Predicted time on Auto counts hidden thinking (ModelInfo.think) in the expected output. A routine later turn never
 * puts a far slower model ahead of a quick adequate one (SLOW_*), and a hard turn never picks one predicted past 90 s
 * on quality alone (HARD_SLOW_*).
 */
export function rank(shape: RequestShape, feasible: { c: Candidate; outTokens: number }[], session: SessionState, health: Health): Scored[] {
  let pool = shape.offScarce ? feasible.filter((f) => !f.c.scarce) : feasible
  if (shape.alias === "fast" && pool.some((f) => f.c.info.quality >= 50)) pool = pool.filter((f) => f.c.info.quality >= 50)
  const opening = shape.alias === "auto" && shape.opening
  // Speed must not promote a weak model over adequate ones; it ranks below them, but stays in the list as a fallback.
  const adequate = opening ? openingFloor(shape.hard, pool) : null
  const holdPaid = shape.alias === "auto" && paidHeldBack(shape, pool, adequate)
  const expectedOut = session.outEwma
  const scored = pool.map(({ c, outTokens }) => {
    const predTtftMs = health.predictTtftMs(c, shape.promptTokens)
    // Fast asks every thinking model for low effort, so only Auto expects a model's default thinking.
    const think = shape.alias === "auto" ? c.info.think : 1
    const genMs = (Math.min(expectedOut * think, outTokens) / health.tps(c)) * 1000
    const predMs = predTtftMs + genMs
    const err = health.errRate(c)
    const belowFloor = adequate !== null && !adequate(c)
    let score: number
    if (shape.alias === "auto") {
      // Free first: a paid key only wins when no good free model can take the turn (a frontier one on hard turns).
      const paid = c.costs ? (holdPaid ? 40 : 0) + costTier(c.model) : 0
      const scarcity = !shape.hard && c.scarce ? (shape.numeric && !opening ? SCARCITY_NUMERIC : SCARCITY_ROUTINE) : 0
      const time = opening ? 6 * (predTtftMs / 1000) : (shape.hard ? 0.5 : 1.5) * (predMs / 1000)
      const weak = belowFloor ? 30 : 0
      score = c.info.quality - time - err * 40 - scarcity - paid - weak
    } else {
      const freeExists = c.costs && pool.some((f) => !f.c.costs)
      const paid = c.costs ? (freeExists ? 5 : 0) + costTier(c.model) : 0
      score = -(2 * predTtftMs + genMs) / 1000 - err * 10 - (c.scarce ? 20 : 0) - paid
    }
    return { c, score, predTtftMs, predMs, outTokens, belowFloor }
  })
  if (shape.alias === "auto" && !opening) {
    if (shape.hard) {
      for (const s of scored) if (s.predMs > HARD_SLOW_MS) s.score -= HARD_SLOW_PENALTY
    } else {
      const adequate = scored.filter((s) => s.c.info.quality >= SLOW_ADEQUATE_QUALITY)
      const free = adequate.filter((s) => !s.c.costs)
      const quickest = Math.min(...(free.length > 0 ? free : adequate).map((s) => s.predMs))
      const limit = Math.max(SLOW_ABS_MS, SLOW_RATIO * quickest)
      for (const s of scored) if (s.predMs > limit) s.score -= SLOW_PENALTY
    }
  }
  return scored.sort((a, b) => b.score - a.score || b.c.info.quality - a.c.info.quality || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))
}

export type Hedge = {
  partner: Scored
  /**
   * The partner is below the opening floor that the first pick clears (a hard opening's quality-60 partner racing a
   * strong first pick): it may answer only once the first pick is actually late, never pre-empt one that is on time.
   */
  patient: boolean
}

/**
 * The backend that races the first one when it is slow to start on an Auto opening turn (core.ts hedges it): the next
 * in the order that is free and not scarce, so the race spends one request of plentiful free quota, never money or a
 * small daily allowance (decision 15), and not on the first pick's own one-at-a-time key, which is busy with it. On a
 * hard opening the partner must also clear the routine floor: its answer may be the one the user gets, and a weak
 * model only stays a fallback. Routine openings race as shipped (2026-10-07).
 */
export function hedgePartner(shape: RequestShape, first: Scored, rest: readonly Scored[]): Hedge | undefined {
  if (shape.alias !== "auto" || !shape.opening) return undefined
  const partner = rest.find(
    (s) => !s.c.scarce && !s.c.costs && !(s.c.serial && s.c.keyScope === first.c.keyScope) && (!shape.hard || s.c.info.quality >= OPENING_QUALITY_FLOOR),
  )
  if (!partner) return undefined
  return { partner, patient: shape.hard && partner.belowFloor && !first.belowFloor }
}

export type Pick = { ordered: Scored[]; reason: "sticky" | "best" | "escalated" | "fallback" | "numeric"; note?: string }

/** Score lead over the sticky backend at which the better one takes over (where a switch is allowed at all). */
const RELEASE_MARGIN = 6

/**
 * A numeric turn on a model below NUMERIC_FLOOR moves to a free one at or above it only when that one is predicted to
 * start at most NUMERIC_TTFT_SLACK_MS and finish at most NUMERIC_TOTAL_SLACK_MS later (docs/QUALITY.md §3): accuracy
 * without giving up the first-token priority. The floor is the registry's coding score until a numeric eval exists.
 */
const NUMERIC_FLOOR = 70
const NUMERIC_TTFT_SLACK_MS = 3_000
const NUMERIC_TOTAL_SLACK_MS = 8_000

/** Predicted to start at most NUMERIC_TTFT_SLACK_MS and finish at most NUMERIC_TOTAL_SLACK_MS after `than`. */
function nearlyAsFast(s: Scored, than: Scored): boolean {
  return s.predTtftMs <= than.predTtftMs + NUMERIC_TTFT_SLACK_MS && s.predMs <= than.predMs + NUMERIC_TOTAL_SLACK_MS
}

/**
 * Session stickiness on top of the ranking. The sticky backend goes first
 * unless: it is unavailable (fallback), the turn is hard and it is below the
 * best grade on offer (escalated: the best-ranked model of that grade goes
 * first; this also moves a chat off the quick model that answered its hard
 * opening, at the very next request), it spends scarce
 * free quota and this is a new routine user turn (released at a turn boundary,
 * where a switch costs least), it has become far slower than the alternative,
 * or the best backend is at least as good a model, now scores clearly higher,
 * and either this is a new user turn or the session only landed on the sticky
 * one through failover. Tool-call continuations of a chosen backend stay put.
 * A numeric user turn on a weaker model moves to a stronger free one that is nearly as fast (reason "numeric").
 */
export function applySticky(ranked: Scored[], session: SessionState, shape: RequestShape): Pick {
  const sid = session.sticky
  if (!sid || ranked.length === 0) return { ordered: ranked, reason: "best" }
  const i = ranked.findIndex((s) => s.c.id === sid)
  if (i < 0) return { ordered: ranked, reason: "fallback", note: "sticky_unavailable" }
  const st = ranked[i]
  // A failover is a stopgap for one turn: every new user message gets a fresh pick, judged on its own prompt.
  if (shape.lastIsUser && session.stickyByFallback) return { ordered: ranked, reason: "best", note: "released_fallback" }
  if (shape.hard) {
    // The best grade on offer, among models the request may use: paid keys only where free first lets them win.
    const offer = paidHeldBack(shape, ranked, null) ? ranked.filter((s) => !s.c.costs) : ranked
    const required = offer.some((s) => s.c.info.grade === "frontier") ? 3 : offer.some((s) => s.c.info.grade === "strong") ? 2 : 0
    if (GRADE_RANK[st.c.info.grade] < required) {
      // The best-ranked model of that grade goes first, whatever outranks it: never a same-grade or weaker one. Once
      // there, it has the grade the rule asks for, so it stays sticky.
      const target = offer.find((s) => GRADE_RANK[s.c.info.grade] >= required)!
      return { ordered: [target, ...ranked.filter((s) => s !== target)], reason: "escalated" }
    }
  }
  if (shape.numeric && shape.lastIsUser && !shape.hard && st.c.info.quality < NUMERIC_FLOOR) {
    // At a user-turn boundary only, where a switch costs least; free only. The first such model in rank order.
    const up = ranked.find((s) => s.c.info.quality >= NUMERIC_FLOOR && !s.c.costs && nearlyAsFast(s, st))
    if (up) return { ordered: [up, ...ranked.filter((s) => s !== up)], reason: "numeric" }
  }
  if (st.c.scarce && shape.lastIsUser && !shape.hard) return { ordered: ranked, reason: "best", note: "released_scarce" }
  const best = ranked[0]
  // A failover onto a paid key is temporary: return to the free backend as soon as it ranks first again.
  if (i > 0 && st.c.costs && !best.c.costs) return { ordered: ranked, reason: "best", note: "released_paid" }
  if (i > 0 && st.predMs > 3 * best.predMs && st.predMs > 30_000) return { ordered: ranked, reason: "best", note: "released_slow" }
  // A numeric turn pays a scarce model less (SCARCITY_NUMERIC), so its better score alone must not buy a slow start:
  // the move to a stronger model obeys the same slack as the numeric rule above.
  const numericSlow = shape.numeric && !session.stickyByFallback && !nearlyAsFast(best, st)
  if (i > 0 && (session.stickyByFallback || shape.lastIsUser) && best.score - st.score > RELEASE_MARGIN && best.c.info.quality >= st.c.info.quality && !numericSlow) {
    return { ordered: ranked, reason: "best", note: session.stickyByFallback ? "released_fallback" : "released_better" }
  }
  return { ordered: [st, ...ranked.slice(0, i), ...ranked.slice(i + 1)], reason: "sticky" }
}
