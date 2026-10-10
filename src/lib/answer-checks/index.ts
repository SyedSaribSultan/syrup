/**
 * syrup's answer checks: deterministic, no model calls, no network, no Node or browser APIs.
 * One library for the chat UI (flags under a finished answer), `pnpm eval:check` and the Tier 0
 * gate (`pnpm test:eval-checks`), so a flag in the UI and a failing test can never disagree.
 * See docs/QUALITY.md (Q0) for why each check exists and what it cannot see.
 *
 *   checkAnswer(markdown, { sources, earlier, referenceRates })  → Finding[]
 *   checkTranscript(parseTranscript(exportText), options)         → per-message findings + counts
 */
import { checkCurrency, inferRupee } from "./currency"
import { checkProvenance } from "./provenance"
import { checkListTotals, checkTableTotals } from "./totals"
import { parseTranscript, type ParsedMessage, type ParsedTool, type ParsedTranscript } from "./transcript"
import type { CheckId, Finding, Rates, Severity, Source } from "./types"
import { checkCitedUrls, normalizeUrl } from "./urls"

export type { CheckId, Finding, Rates, Severity, Source } from "./types"
export type { Amount, ParseOptions } from "./money"
export type { MessageMeta, ParsedMessage, ParsedTool, ParsedTranscript, Turn } from "./transcript"
export { fmtMoney, fmtRange, hasStrayDigits, parseAmounts } from "./money"
export { checkCurrency, inferRupee, statedRates } from "./currency"
export { checkListTotals, checkTableTotals } from "./totals"
export { checkProvenance } from "./provenance"
export { checkCitedUrls, citedLinks, normalizeUrl, seenUrls } from "./urls"
export { parseDuration, parseTokenCount, parseTranscript } from "./transcript"

/**
 * Reference rates for the magnitude check when an answer states none. Dated, and deliberately
 * coarse: the check only fails beyond 1.5x, so drift of a few percent never matters. Callers with
 * a live rate (the Q3 calc tool's cache) pass their own.
 */
export const REFERENCE_RATES: Rates = { USD: { PKR: 277, INR: 88, EUR: 0.86, GBP: 0.75, AED: 3.6725, SAR: 3.75 } }
export const REFERENCE_RATES_AS_OF = "2026-10-08"

/** The context budget for one request (docs/QUALITY.md §7: the K2 replay's last turn ≤ 15k). */
export const CONTEXT_BUDGET = 15_000

export type AnswerContext = {
  /** What the agent read before and while answering: tool inputs and outputs, attached files, the user's words. */
  sources?: Source[]
  /** Earlier answers in the same chat (a number repeated from one isn't new). */
  earlier?: string[]
  referenceRates?: Rates
  rupee?: "PKR" | "INR"
}

const WEB = /web|search|fetch|browse|crawl|scrape|exa/i

/** True when the sources include something read from the web: only then are provenance and links checked. */
export const usedWeb = (sources: Source[]) => sources.some((s) => WEB.test(s.kind))

/** Every check on one finished answer. */
export function checkAnswer(md: string, ctx: AnswerContext = {}): Finding[] {
  const rupee = ctx.rupee ?? inferRupee(md)
  const sources = ctx.sources ?? []
  const out = [...checkTableTotals(md, { rupee }), ...checkListTotals(md, { rupee }), ...checkCurrency(md, { rupee, reference: ctx.referenceRates ?? REFERENCE_RATES })]
  if (usedWeb(sources)) out.push(...checkProvenance(md, { sources, earlier: ctx.earlier, rupee }), ...checkCitedUrls(md, sources))
  return out
}

const inputText = (input: unknown) => (typeof input === "string" ? input : JSON.stringify(input ?? {}))

/** Turns tool calls into sources: a search result per URL, a fetched page with its URL, any other tool's text. */
export function sourcesFromTools(tools: ParsedTool[]): Source[] {
  const out: Source[] = []
  for (const t of tools) {
    const input = inputText(t.input)
    const output = [t.output ?? "", t.error ?? ""].filter(Boolean).join("\n")
    const inputUrl = typeof t.input === "object" && t.input ? (t.input as Record<string, unknown>).url : undefined
    if (/search/i.test(t.tool) && /^Title: /m.test(output)) {
      // Exa results: "Title: …\nURL: …\n…" blocks.
      const blocks = output.split(/\n(?=Title: )/)
      for (const b of blocks) {
        const url = /^URL: (\S+)/m.exec(b)?.[1]
        out.push({ kind: t.tool, text: b, ...(url && { url }) })
      }
      out.push({ kind: t.tool, text: input })
      continue
    }
    out.push({ kind: t.tool, text: `${input}\n${output}`, ...(typeof inputUrl === "string" && normalizeUrl(inputUrl) && { url: inputUrl }) })
  }
  return out
}

export type MessageReport = {
  index: number
  turn: number
  label?: string
  /** The user message this answers (first line). */
  question?: string
  findings: Finding[]
}

export type TranscriptReport = {
  title: string
  form: ParsedTranscript["form"]
  messages: number
  questions: number
  /** Assistant messages with at least one finding. */
  reports: MessageReport[]
  counts: Record<Severity, number>
  byCheck: Partial<Record<CheckId, Record<Severity, number>>>
}

export type TranscriptOptions = { referenceRates?: Rates; contextBudget?: number }

function contextFindings(m: ParsedMessage, budget: number): Finding[] {
  const out: Finding[] = []
  const tokens = m.meta.inputTokens ?? m.meta.tokens
  if (tokens && tokens > budget) {
    const exact = m.meta.inputTokens !== undefined
    out.push({
      check: "context",
      severity: tokens > budget * 4 ? "warn" : "hint",
      message: `This answer's request used ${exact ? "" : "about "}${Math.round(tokens / 1000)}k ${exact ? "input " : ""}tokens; the budget is ${Math.round(budget / 1000)}k.`,
      evidence: { excerpt: `${tokens} tokens`, tokens, budget, exact },
    })
  }
  if (m.meta.error)
    out.push({ check: "finished", severity: "warn", message: `The answer ended with an error: ${m.meta.error.split("\n")[0].slice(0, 160)}`, evidence: { excerpt: m.meta.error.slice(0, 400) } })
  else if (m.meta.unfinished && !m.tools.some((t) => t.status === "running" || t.status === "pending"))
    out.push({ check: "finished", severity: "hint", message: "The answer was still being written when the chat was exported.", evidence: { excerpt: m.text.slice(-200) } })
  return out
}

/** Runs every check over an exported chat, each answer against what the agent had read by then. */
export function checkTranscript(t: ParsedTranscript, opts: TranscriptOptions = {}): TranscriptReport {
  const budget = opts.contextBudget ?? CONTEXT_BUDGET
  const all = t.messages.map((m) => m.text).join("\n")
  const rupee = inferRupee(all)
  const sources: Source[] = []
  const earlier: string[] = []
  const reports: MessageReport[] = []
  let turn = 0
  let question: string | undefined
  for (const m of t.messages) {
    if (m.role === "user") {
      turn++
      question = m.text.split("\n").find((l) => l.trim())?.trim()
      sources.push({ kind: "user", text: m.text }, ...m.context.map((c) => ({ kind: "attached", text: c })))
      continue
    }
    sources.push(...sourcesFromTools(m.tools))
    const findings = contextFindings(m, budget)
    if (m.text.trim()) findings.push(...checkAnswer(m.text, { sources: [...sources], earlier: [...earlier], referenceRates: opts.referenceRates, rupee }))
    if (m.text.trim()) earlier.push(m.text)
    if (findings.length) reports.push({ index: m.index, turn, ...(m.label && { label: m.label }), ...(question && { question }), findings })
  }
  const counts: Record<Severity, number> = { error: 0, warn: 0, hint: 0 }
  const byCheck: TranscriptReport["byCheck"] = {}
  for (const r of reports)
    for (const f of r.findings) {
      counts[f.severity]++
      const c = (byCheck[f.check] ??= { error: 0, warn: 0, hint: 0 })
      c[f.severity]++
    }
  return { title: t.title, form: t.form, messages: t.messages.length, questions: turn, reports, counts, byCheck }
}

/** Parse and check in one go (the CLI's path). */
export function checkExport(src: string, opts: TranscriptOptions = {}): TranscriptReport {
  return checkTranscript(parseTranscript(src), opts)
}
