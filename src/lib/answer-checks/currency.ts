/**
 * Currency magnitude: wherever an answer pairs an amount in one currency with its conversion
 * (a table row with a USD and a PKR column, "$5,000 (about PKR 13.9 lakh)", a heading with the
 * USD figure in brackets under it), the ratio must match the rate.
 * - If the answer states a rate ("~277 PKR per 1 USD"), the ratio must be within 3% of it (or of
 *   what the shown digits allow by rounding); a miss under 1.5x is a warning.
 * - Off by more than 1.5x from the stated rate, or (when none is stated) from the reference rate
 *   the caller passes, is an error. That catches every 10x lakh/crore slip and never trips on
 *   normal exchange-rate drift. The library never fetches a rate.
 */
import { mdLines, parseTables, plain } from "./markdown"
import { hasStrayDigits, parseAmounts, type Amount } from "./money"
import { cellAmount, headerCurrency } from "./totals"
import type { Finding, Rates } from "./types"

export type CurrencyOptions = { rupee?: "PKR" | "INR"; reference?: Rates }

const NUMBER = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)`
const LOCAL = String.raw`(PKR|INR|EUR|GBP|Rs\.?|₨|₹|€|£|rupees?|euros?)`
const DOLLAR = String.raw`(?:USD|US\$|\$|U\.?S\.? dollars?|dollars?)`

const RATE_PATTERNS: RegExp[] = [
  // 1 USD = 277 PKR · $1 ≈ PKR 277 · 1 dollar is about Rs 277
  new RegExp(String.raw`(?:\b1\s*${DOLLAR}|\$\s*1(?![\d.,]))\s*(?:=|≈|~|:|\bis\b|\bequals\b|\bbuys\b|\bto\b)\s*(?:about\s+|around\s+|roughly\s+|approx\.?\s+|~\s*)?${LOCAL}?\s*${NUMBER}\s*${LOCAL}?`, "gi"),
  // 277 PKR per USD · ~277 PKR per 1 USD · Rs 277/$ · PKR 277 to the dollar
  new RegExp(String.raw`${LOCAL}?\s*${NUMBER}\s*${LOCAL}?\s*(?:per|\/|to the|for (?:one|1|each|a|every))\s*(?:1\s*)?${DOLLAR}`, "gi"),
  // USD/PKR 277 · USD to PKR rate of 277 · PKR/USD: 277
  new RegExp(String.raw`\b(?:USD\s*[/-]\s*(PKR|INR|EUR|GBP)|(PKR|INR|EUR|GBP)\s*[/-]\s*USD|USD[- ]to[- ](PKR|INR|EUR|GBP))\b[^\d\n]{0,30}?${NUMBER}`, "gi"),
]

function localCode(token: string | undefined, rupee: "PKR" | "INR"): string | null {
  if (!token) return null
  const t = token.toLowerCase()
  if (t === "pkr") return "PKR"
  if (t === "inr" || t === "₹") return "INR"
  if (t === "eur" || t === "€" || t.startsWith("euro")) return "EUR"
  if (t === "gbp" || t === "£") return "GBP"
  return rupee
}

/** Rates the answer itself states, per USD: { PKR: 277 }. */
export function statedRates(md: string, rupee: "PKR" | "INR" = "PKR"): Record<string, number> {
  const out: Record<string, number> = {}
  const text = plain(md)
  for (const re of RATE_PATTERNS) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const groups = m.slice(1).filter((g): g is string => g !== undefined)
      const numTok = groups.find((g) => /^\d/.test(g))
      const curTok = groups.find((g) => !/^\d/.test(g))
      const cur = localCode(curTok, rupee)
      const v = numTok ? Number(numTok.replace(/,/g, "")) : NaN
      if (cur && Number.isFinite(v) && v > 0 && !(cur in out)) out[cur] = v
    }
  }
  return out
}

/** Which rupee an answer means: INR when it talks about India and not Pakistan, else PKR. */
export function inferRupee(text: string): "PKR" | "INR" {
  const pk = (text.match(/\bPKR\b|\bPakistan/gi) ?? []).length
  const inr = (text.match(/\bINR\b|₹|\bIndia(?:n)?\b/gi) ?? []).length
  return inr > pk ? "INR" : "PKR"
}

function rateFor(rates: Rates | undefined, from: string, to: string): number | null {
  if (!rates) return null
  const direct = rates[from]?.[to]
  if (direct) return direct
  const inverse = rates[to]?.[from]
  return inverse ? 1 / inverse : null
}

type Pair = { a: Amount; b: Amount; excerpt: string; line: number }

/** Words that present two amounts in one sentence as the same money. */
const CONVERSION_CUE = /[≈~=]|\b(?:is|are|was|were|comes? to|came to|converts? to|works? out (?:to|at)|equals?|equal to|equivalent|about|around|roughly|approximately|approx|nearly|which is|that's|that is|in (?:PKR|INR|rupees?|dollars?|USD))\b/i

/** Stated exchange rates ("1 USD = 277 PKR", "277 PKR per USD", "at Rs 277/$") blanked out, offsets kept, so they are not amounts. */
function blankRates(t: string): string {
  const RATE = /\b1\s*(?:USD|US\$|\$|dollars?)\s*=\s*(?:PKR|INR|Rs\.?|₨|₹)?\s*[\d.,]+\s*(?:PKR|INR|rupees?)?|(?:PKR|INR|Rs\.?|₨|₹)?\s*[\d.,]+\s*(?:PKR|INR|rupees?)?\s*(?:per|\/|a|to the|to a)\s*(?:USD|US\$|\$|dollars?|U\.S\. dollars?)\b/gi
  return t.replace(RATE, (m) => " ".repeat(m.length))
}

/** "per month", "/year", "a day" right after an amount; "" when none. */
function periodAfter(t: string, a: Amount): string {
  const m = /^\+?\s*(?:\/|per|a|an|each|every)\s*(month|mo|year|yr|annum|week|day|night|hour|hr)\b/i.exec(t.slice(a.end))
  if (!m) return ""
  const p = m[1].toLowerCase()
  return p === "mo" ? "month" : p === "yr" || p === "annum" ? "year" : p === "hr" ? "hour" : p
}

/** Sentence spans of one prose line (". ", "! ", "? ", "; " end a sentence; decimals and "approx." don't). */
function sentences(t: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let start = 0
  const END = /(?<!\b(?:approx|vs|e\.g|i\.e|etc|Rs|no|St|Mr|Dr))[.!?;](?=\s|$)/g
  for (let m = END.exec(t); m; m = END.exec(t)) {
    out.push({ start, end: m.index + 1 })
    start = m.index + 1
  }
  if (start < t.length) out.push({ start, end: t.length })
  return out
}

/** Pairs of amounts in two currencies that the answer presents as the same money. */
function pairs(md: string, rupee: "PKR" | "INR"): Pair[] {
  const lines = mdLines(md)
  const out: Pair[] = []
  const inTable = new Set<number>()

  for (const table of parseTables(lines)) {
    inTable.add(table.line)
    inTable.add(table.line + 1)
    const curs = table.header.map((h) => headerCurrency(h, rupee))
    for (const row of table.rows) {
      inTable.add(row.line)
      const cells = row.cells.map((c, i) => (i === 0 ? null : cellAmount(c, curs[i] ?? null, rupee))).filter((a): a is Amount => !!a && !!a.cur && (a.lo > 0 || a.hi > 0))
      const usd = cells.filter((a) => a.cur === "USD")
      const other = cells.filter((a) => a.cur !== "USD")
      if (usd.length !== 1) continue
      for (const o of other) out.push({ a: usd[0], b: o, excerpt: row.raw.trim(), line: row.line })
    }
  }

  const GAP = /^[\s(\[≈~=:,/|→-]*(?:about|approx\.?|approximately|roughly|around|i\.e\.?|or|equals|equal to|equivalent to|which is|that is|or about|so)?[\s(\[≈~=:,/|→-]*$/i
  const prose = lines.filter((l) => !l.code && !inTable.has(l.index) && l.text.trim())
  prose.forEach((l, k) => {
    const t = blankRates(plain(l.text))
    const amounts = parseAmounts(t, { rupee }).filter((a) => a.cur)
    const paired = new Set<Amount>()
    // Adjacent: "$5,000 (about PKR 13.9 lakh)", "PKR 4.1 crore ($15,000)".
    for (let i = 0; i + 1 < amounts.length; i++) {
      const x = amounts[i]
      const y = amounts[i + 1]
      if (x.cur === y.cur) continue
      if (!GAP.test(t.slice(x.end + (x.plus ? 1 : 0), y.start))) continue
      out.push({ a: x, b: y, excerpt: l.text.trim(), line: l.index })
      paired.add(x).add(y)
      i++
    }
    // One sentence, one USD amount and one amount in one other currency, joined by a conversion cue:
    // "$15,000 is about PKR 4.1 crore", "That comes to roughly 4.1 crore PKR for a $15,000 budget".
    for (const s of sentences(t)) {
      const inS = amounts.filter((a) => a.start >= s.start && a.end <= s.end && !paired.has(a))
      const usd = inS.filter((a) => a.cur === "USD")
      const other = inS.filter((a) => a.cur !== "USD")
      if (usd.length !== 1 || other.length !== 1) continue
      if (!CONVERSION_CUE.test(t.slice(s.start, s.end))) continue
      if (periodAfter(t, usd[0]) !== periodAfter(t, other[0])) continue
      out.push({ a: usd[0], b: other[0], excerpt: l.text.trim(), line: l.index })
    }
    // A heading or line in one currency with the other in brackets on the next line.
    const next = prose[k + 1]
    if (!next || next.index > l.index + 2) return
    const nt = plain(next.text).trim()
    if (!nt.startsWith("(")) return
    const below = parseAmounts(nt, { rupee }).filter((a) => a.cur)
    const curA = new Set(amounts.map((a) => a.cur))
    const curB = new Set(below.map((a) => a.cur))
    if (amounts.length === 1 && below.length === 1 && curA.size === 1 && curB.size === 1 && amounts[0].cur !== below[0].cur && !hasStrayDigits(nt, below))
      out.push({ a: amounts[0], b: below[0], excerpt: `${l.text.trim()} / ${next.text.trim()}`, line: l.index })
  })
  return out
}

const fmtRate = (r: number) => (r >= 100 ? Math.round(r).toLocaleString("en-US") : r >= 1 ? r.toFixed(2) : r.toPrecision(3))

export function checkCurrency(md: string, opts: CurrencyOptions = {}): Finding[] {
  const rupee = opts.rupee ?? inferRupee(md)
  const stated = statedRates(md, rupee)
  const out: Finding[] = []
  for (const p of pairs(md, rupee)) {
    // Orient as USD → other when USD is involved; otherwise as written.
    const [x, y] = p.b.cur === "USD" ? [p.b, p.a] : [p.a, p.b]
    const from = x.cur as string
    const to = y.cur as string
    if (x.range !== y.range) continue
    const ratios = x.range ? [y.lo / x.lo, y.hi / x.hi] : [y.lo / x.lo]
    if (ratios.some((r) => !Number.isFinite(r) || r <= 0)) continue
    const own = from === "USD" ? stated[to] : undefined
    const ref = rateFor(opts.reference, from, to)
    const expected = own ?? ref
    if (!expected) continue
    const factor = Math.max(...ratios.map((r) => Math.max(r / expected, expected / r)))
    const worst = ratios.reduce((w, r) => (Math.max(r / expected, expected / r) > Math.max(w / expected, expected / w) ? r : w), ratios[0])
    const what = `${y.text.trim()}${y.plus ? "+" : ""} for ${x.text.trim()}${x.plus ? "+" : ""}`
    const source = own ? `the rate this answer states (${fmtRate(own)} ${to} per ${from})` : `the reference rate (${fmtRate(expected)} ${to} per ${from})`
    if (factor > 1.5) {
      out.push({
        check: "currency",
        severity: "error",
        message: `${what} is ${fmtRate(worst)} ${to} per ${from}: ${factor.toFixed(1)}x off ${source}.`,
        evidence: { excerpt: p.excerpt, line: p.line + 1, from, to, ratio: worst, expected, factor, statedRate: own ?? null },
      })
      continue
    }
    if (own) {
      // The converted figure is the rounded one; the source figure is taken as exact.
      const tol = Math.max(0.03, y.precision)
      const dev = Math.max(...ratios.map((r) => Math.abs(r / own - 1)))
      if (dev > tol)
        out.push({
          check: "currency",
          severity: "warn",
          message: `${what} is ${fmtRate(worst)} ${to} per ${from}, ${(dev * 100).toFixed(1)}% off ${source}.`,
          evidence: { excerpt: p.excerpt, line: p.line + 1, from, to, ratio: worst, expected: own, deviation: dev, tolerance: tol },
        })
    }
  }
  // A stated rate far from the reference is itself suspect.
  for (const [to, v] of Object.entries(stated)) {
    const ref = rateFor(opts.reference, "USD", to)
    if (ref && Math.max(v / ref, ref / v) > 1.5)
      out.push({
        check: "currency",
        severity: "warn",
        message: `The answer's rate (${fmtRate(v)} ${to} per USD) is ${Math.max(v / ref, ref / v).toFixed(1)}x off the reference rate (${fmtRate(ref)}).`,
        evidence: { excerpt: `${v} ${to} per USD`, to, stated: v, reference: ref },
      })
  }
  return out
}
