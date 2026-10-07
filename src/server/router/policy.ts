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
  /** Output tokens the caller allows (max_completion_tokens ?? max_tokens ?? 8192). */
  requestedOut: number
  hasImage: boolean
  hard: boolean
  hardWhy: string | null
  /** The last message is the user's (a new turn, not a tool-call continuation). */
  lastIsUser: boolean
  /** The chat's very first turn: one user message, nothing answered yet. Nothing is cached and the screen is blank. */
  opening: boolean
}

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

/**
 * Judged from the latest user message, so every step of a turn (tool calls, a continuation after a cut-off)
 * shares its verdict. Hard for planning/debugging-type asks, for substantial work (two or more work signals),
 * or while the session keeps failing tool calls. Auto only.
 */
export function difficulty(alias: Alias, messages: Msg[], session: SessionState, now: number): { hard: boolean; why: string | null } {
  if (alias !== "auto") return { hard: false, why: null }
  const failures = trailingToolFailures(messages)
  if (failures >= 2) session.escalatedUntil = now + ESCALATE_MS
  const ask = [...messages].reverse().find((m) => m.role === "user")
  if (ask) {
    const text = textOf(ask.content).slice(0, 20_000)
    const m = HARD_RE.exec(text)
    if (m) return { hard: true, why: `keyword:${m[1].toLowerCase()}` }
    const signals = workSignals(text)
    if (signals.length >= 2) return { hard: true, why: `work:${signals.join("+")}` }
  }
  if (failures >= 2) return { hard: true, why: `tool_failures:${failures}` }
  if (session.escalatedUntil > now) return { hard: true, why: "escalated" }
  return { hard: false, why: null }
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
}

const GRADE_RANK: Record<Grade, number> = { small: 0, mid: 1, strong: 2, frontier: 3 }

/** Quality a free model needs to be picked for its speed on a chat's opening turn. */
const OPENING_QUALITY_FLOOR = 60

/**
 * Orders feasible candidates, best first.
 * Auto: quality − time − risk − scarcity − paid, where time is cheap on hard turns and scarcity only applies to routine ones.
 * On a chat's routine opening turn, time means the predicted first token and weighs four times more: the user is
 * looking at a blank screen and nothing is cached yet, so the model that answers first wins among adequate ones.
 * Fast: least predicted wall time (first token weighted double), quality floor 50.
 */
export function rank(shape: RequestShape, feasible: { c: Candidate; outTokens: number }[], session: SessionState, health: Health): Scored[] {
  let pool = feasible
  if (shape.alias === "fast" && pool.some((f) => f.c.info.quality >= 50)) pool = pool.filter((f) => f.c.info.quality >= 50)
  const opening = shape.alias === "auto" && shape.opening && !shape.hard
  // Speed must not promote a weak model over adequate ones; it ranks below them, but stays in the list as a fallback.
  const adequateFree = opening && pool.some((f) => !f.c.costs && f.c.info.quality >= OPENING_QUALITY_FLOOR)
  const expectedOut = session.outEwma
  const scored = pool.map(({ c, outTokens }) => {
    const predTtftMs = health.predictTtftMs(c, shape.promptTokens)
    const genMs = (Math.min(expectedOut, outTokens) / health.tps(c)) * 1000
    const predMs = predTtftMs + genMs
    const err = health.errRate(c)
    let score: number
    if (shape.alias === "auto") {
      // Free first: a paid key only wins when no good free model can take the turn (a frontier one on hard turns).
      const freeBar = shape.hard ? 84 : 70
      const freeGood = c.costs && pool.some((f) => !f.c.costs && f.c.info.quality >= freeBar)
      const paid = c.costs ? (freeGood ? 40 : 0) + costTier(c.model) : 0
      const scarcity = !shape.hard && c.scarce ? 25 : 0
      const time = opening ? 6 * (predTtftMs / 1000) : (shape.hard ? 0.5 : 1.5) * (predMs / 1000)
      const weak = adequateFree && c.info.quality < OPENING_QUALITY_FLOOR ? 30 : 0
      score = c.info.quality - time - err * 40 - scarcity - paid - weak
    } else {
      const freeExists = c.costs && pool.some((f) => !f.c.costs)
      const paid = c.costs ? (freeExists ? 5 : 0) + costTier(c.model) : 0
      score = -(2 * predTtftMs + genMs) / 1000 - err * 10 - (c.scarce ? 20 : 0) - paid
    }
    return { c, score, predTtftMs, predMs, outTokens }
  })
  return scored.sort((a, b) => b.score - a.score || b.c.info.quality - a.c.info.quality || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))
}

export type Pick = { ordered: Scored[]; reason: "sticky" | "best" | "escalated" | "fallback"; note?: string }

/** Score lead over the sticky backend at which the better one takes over (where a switch is allowed at all). */
const RELEASE_MARGIN = 6

/**
 * Session stickiness on top of the ranking. The sticky backend goes first
 * unless: it is unavailable (fallback), the turn is hard and it is below the
 * best grade on offer (escalated), it spends scarce free quota and this is a
 * new routine user turn (released at a turn boundary, where a switch costs
 * least), it has become far slower than the alternative, or the best backend
 * is at least as good a model, now scores clearly higher, and either this is
 * a new user turn or the session only landed on the sticky one through
 * failover. Tool-call continuations of a chosen backend stay put.
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
    const required = ranked.some((s) => s.c.info.grade === "frontier") ? 3 : ranked.some((s) => s.c.info.grade === "strong") ? 2 : 0
    if (GRADE_RANK[st.c.info.grade] < required) return { ordered: ranked, reason: i === 0 ? "best" : "escalated" }
  }
  if (st.c.scarce && shape.lastIsUser && !shape.hard) return { ordered: ranked, reason: "best", note: "released_scarce" }
  const best = ranked[0]
  // A failover onto a paid key is temporary: return to the free backend as soon as it ranks first again.
  if (i > 0 && st.c.costs && !best.c.costs) return { ordered: ranked, reason: "best", note: "released_paid" }
  if (i > 0 && st.predMs > 3 * best.predMs && st.predMs > 30_000) return { ordered: ranked, reason: "best", note: "released_slow" }
  if (i > 0 && (session.stickyByFallback || shape.lastIsUser) && best.score - st.score > RELEASE_MARGIN && best.c.info.quality >= st.c.info.quality) {
    return { ordered: ranked, reason: "best", note: session.stickyByFallback ? "released_fallback" : "released_better" }
  }
  return { ordered: [st, ...ranked.slice(0, i), ...ranked.slice(i + 1)], reason: "sticky" }
}
