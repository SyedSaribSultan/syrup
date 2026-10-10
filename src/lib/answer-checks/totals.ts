/**
 * Totals must equal their parts.
 * - Tables: a row labelled Total (Grand total, Estimated total, TOTAL ESTIMATE, Sum) must equal the
 *   rows above it, per column, low ends and high ends separately. Tolerance max(2%, 1 unit).
 *   Subtotal rows are skipped. A column is checked only when every cell holds exactly one amount.
 * - Lists: two or more priced items with a total stated right before the list ("costs $30k–65k
 *   all-in"), right after it ("**Total: $40k–74k**"), or as its last item. Tolerance 5% (prose rounds).
 */
import { mdLines, parseLists, parseTables, plain, type ListItem } from "./markdown"
import { fmtRange, hasStrayDigits, parseAmounts, type Amount } from "./money"
import type { Finding } from "./types"

export type TotalsOptions = { rupee?: "PKR" | "INR" }

export const TOTAL_LABEL = /^\W*(?:(?:estimated|grand|approx(?:imate)?|overall|all[- ]in|rough|final)\s+)?(?:total|sum)\b/i
const TOTAL_WORD = /\b(?:total|all[- ]in|altogether|in all|combined)\b/i
const SUBTOTAL = /\bsub[- ]?total/i
const OPTIONAL = /\b(?:optional|extras?|add[- ]ons?|not included|excluded|if needed|if required)\b/i
const ZERO = /^(?:included|incl\.?|free|nil|none|n\/a|—|–|-|\$?0(?:\.0+)?)$/i
/** A price per something (per day, a night, per person, each): it can't be summed into a trip's total. */
const RATE = /(?:\bper\s+|\/\s*|\ba\s+|\beach\s+)(?:day|night|week|month|year|hour|kg|km|mile|unit|item|load|stage|trip|person|head|pax|seat|ticket|member|guest|room|piece|adult|child)s?\b|\beach\b|\bapiece\b/i
const BREAKDOWN = /\b(?:break ?down|broken down|breakdown|consists? of|made up of|comprises?|itemi[sz]ed|split(?: up)? (?:into|as)|adds? up)\b/i
const ALTERNATIVES = /\b(?:option|tier|plan|budget|mid-?range|luxury|basic|premium|standard|economy|deluxe|vip|cheapest|best)\b/i

const AVERAGE = /\b(?:blended|average|avg|mean|median|weighted|typical)\b/i
const RATE_COLUMN = /\b(?:cpc|cpa|cpm|cpl|ctr|roas|avg|average|mean|median|rate|ratio|unit price|unit cost|price per|cost per|per (?:unit|night|day|month|hour|person|seat|item|click)|each)\b|%/i

const close = (a: number, b: number, rel: number) => Math.abs(a - b) <= Math.max(rel * Math.max(Math.abs(a), Math.abs(b)), 1)

const HEADER_CURRENCIES: [RegExp, string | "rupee"][] = [
  [/\bUSD\b|US\$|\bdollars?\b|\$/i, "USD"],
  [/\bPKR\b/i, "PKR"],
  [/\bINR\b|₹/, "INR"],
  [/\bRs\.?(?![a-z])|₨|\brupees?\b/i, "rupee"],
  [/\bEUR\b|€|\beuros?\b/i, "EUR"],
  [/\bGBP\b|£/i, "GBP"],
  [/\bAED\b|\bdirhams?\b/i, "AED"],
  [/\bSAR\b|\briyals?\b/i, "SAR"],
]

/** The currency a table header cell names, when it names exactly one. */
export function headerCurrency(cell: string, rupee: "PKR" | "INR"): string | null {
  const hits = new Set<string>()
  for (const [re, cur] of HEADER_CURRENCIES) if (re.test(cell)) hits.add(cur === "rupee" ? rupee : cur)
  return hits.size === 1 ? [...hits][0] : null
}

/** The one amount a table cell holds, a zero for "Included"/"—", or null when it holds something else. */
export function cellAmount(cell: string, currency: string | null, rupee: "PKR" | "INR"): Amount | null {
  const t = plain(cell).trim()
  if (ZERO.test(t)) return { lo: 0, hi: 0, cur: currency, kind: "money", range: false, approx: false, plus: false, precision: 0, text: t, start: 0, end: t.length }
  const a = parseAmounts(t, { currency, rupee })
  if (a.length !== 1 || hasStrayDigits(t, a)) return null
  return a[0]
}

type Sum = { lo: number; hi: number }
const sum = (xs: Amount[]): Sum => ({ lo: xs.reduce((s, a) => s + a.lo, 0), hi: xs.reduce((s, a) => s + a.hi, 0) })

/**
 * How a stated total compares with the sum of its parts:
 * "ok", "mismatch", or "loose" (a single figure inside a range of parts, or the other way round: an estimate, not an error).
 */
function compare(stated: Amount, parts: Sum, rel: number): "ok" | "mismatch" | "loose" {
  const tol = stated.approx ? Math.max(rel, stated.precision) : rel
  const partsRange = parts.lo !== parts.hi
  if (stated.range === partsRange) return close(stated.lo, parts.lo, tol) && close(stated.hi, parts.hi, tol) ? "ok" : "mismatch"
  if (close(stated.lo, parts.lo, tol) && close(stated.hi, parts.hi, tol)) return "ok"
  // Mixed shapes: a single total inside the parts' range (or parts' single sum inside a stated range) is a judgement call.
  const inside = (v: number, lo: number, hi: number) => v >= lo * (1 - tol) && v <= hi * (1 + tol)
  if (!stated.range && inside(stated.lo, parts.lo, parts.hi)) return "loose"
  if (stated.range && inside(parts.lo, stated.lo, stated.hi)) return "loose"
  return "mismatch"
}

export function checkTableTotals(md: string, opts: TotalsOptions = {}): Finding[] {
  const rupee = opts.rupee ?? "PKR"
  const out: Finding[] = []
  for (const table of parseTables(mdLines(md))) {
    const totals = table.rows.map((r, i) => (TOTAL_LABEL.test(plain(r.cells[0] ?? "")) ? i : -1)).filter((i) => i >= 0)
    // Exactly one Total row, with rows above it, and nothing after it but notes.
    if (totals.length !== 1 || totals[0] < 2) continue
    const ti = totals[0]
    const totalRow = table.rows[ti]
    // "Total / blended", "Total (average)": a row of averages, not sums.
    if (AVERAGE.test(plain(totalRow.cells[0] ?? ""))) continue
    const body = table.rows.slice(0, ti).filter((r) => !SUBTOTAL.test(plain(r.cells[0] ?? "")) && r.cells.some((c) => c.trim()))
    if (body.length < 2) continue
    for (let c = 1; c < table.header.length; c++) {
      // A column of rates or unit prices (CPC, CPA, "Price per night", "Rate", "%") is never summed.
      if (RATE_COLUMN.test(plain(table.header[c]))) continue
      const cur = headerCurrency(table.header[c], rupee)
      const stated = cellAmount(totalRow.cells[c] ?? "", cur, rupee)
      if (!stated) continue
      const cells = body.map((r) => cellAmount(r.cells[c] ?? "", cur, rupee))
      if (cells.some((a) => a === null)) continue
      const parts = cells as Amount[]
      const curs = new Set([stated.cur, ...parts.filter((p) => p.lo || p.hi).map((p) => p.cur)])
      if (curs.size > 1) continue
      const all = sum(parts)
      const verdict = compare(stated, all, 0.02)
      if (verdict === "ok") continue
      // Rows marked optional may be left out of the total on purpose.
      const required = body.map((r, i) => (OPTIONAL.test(plain(r.cells[0] ?? "")) ? null : parts[i])).filter((a): a is Amount => !!a)
      if (required.length !== parts.length && compare(stated, sum(required), 0.02) !== "mismatch") continue
      const curName = stated.cur
      out.push({
        check: "table-total",
        severity: verdict === "loose" ? "hint" : "error",
        message:
          verdict === "loose"
            ? `The ${plain(totalRow.cells[0]).trim()} row gives ${fmtRange(stated.lo, stated.hi, curName)} where the ${body.length} rows above it span ${fmtRange(all.lo, all.hi, curName)}; say whether it is a midpoint or a typical case.`
            : `The ${plain(totalRow.cells[0]).trim()} row says ${stated.text.trim()}${stated.plus ? "+" : ""}, but the ${body.length} rows above it add up to ${fmtRange(all.lo, all.hi, curName)}.`,
        evidence: { excerpt: totalRow.raw.trim(), line: totalRow.line + 1, column: plain(table.header[c]).trim(), stated: { lo: stated.lo, hi: stated.hi, currency: curName }, computed: { lo: all.lo, hi: all.hi }, rows: body.length },
      })
    }
  }
  return out
}

/** The total amount on a prose line: the first amount after the total word, else the last one before it. */
function totalOn(text: string, rupee: "PKR" | "INR", needWord: boolean): Amount | null {
  const t = plain(text)
  const word = TOTAL_WORD.exec(t) ?? TOTAL_LABEL.exec(t)
  if (needWord && !word) return null
  const amounts = parseAmounts(t, { rupee })
  if (!amounts.length) return null
  if (!word) return amounts.length === 1 ? amounts[0] : null
  return amounts.find((a) => a.start >= word.index) ?? amounts[amounts.length - 1]
}

/** The period an item's label names: "Monthly cost" → "month", "Annual fee" → "year"; "" for none. */
function periodWord(label: string): string {
  const m = /\b(monthly|month|annual(?:ly)?|yearly|year|weekly|week|daily|day)\b/i.exec(label)
  if (!m) return ""
  const w = m[1].toLowerCase()
  return w.startsWith("month") ? "month" : w.startsWith("annual") || w.startsWith("year") ? "year" : w.startsWith("week") ? "week" : "day"
}

export function checkListTotals(md: string, opts: TotalsOptions = {}): Finding[] {
  const rupee = opts.rupee ?? "PKR"
  const out: Finding[] = []
  for (const block of parseLists(mdLines(md))) {
    let items: ListItem[] = block.items
    // Two or more "Total …" items ("Total paid: …", "Total interest: …") are derived figures, not a breakdown.
    if (items.filter((it) => TOTAL_LABEL.test(plain(it.text))).length > 1) continue
    type Candidate = { amount: Amount; line: number; excerpt: string; where: "item" | "after" | "before"; text: string }
    const candidates: Candidate[] = []
    const last = items[items.length - 1]
    if (last && TOTAL_LABEL.test(plain(last.text))) {
      const a = totalOn(last.text, rupee, false)
      if (a) candidates.push({ amount: a, line: last.line, excerpt: last.raw.trim(), where: "item", text: last.text })
      items = items.slice(0, -1)
    }
    if (block.after) {
      const a = totalOn(block.after.text, rupee, true)
      if (a) candidates.push({ amount: a, line: block.after.line, excerpt: block.after.text.trim(), where: "after", text: block.after.text })
    }
    for (const b of block.before) {
      // "The trip costs about $3,900, broken down as:" states the total without the word.
      const a = totalOn(b.text, rupee, !BREAKDOWN.test(plain(b.text)))
      if (a) candidates.push({ amount: a, line: b.line, excerpt: b.text.trim(), where: "before", text: b.text })
    }
    if (!candidates.length || items.length < 2) continue
    const total = candidates[0]
    const T = total.amount

    // Each item's amount in the total's currency.
    const priced: { item: ListItem; amount: Amount }[] = []
    let unpriced = 0
    let ambiguous = false
    for (const item of items) {
      const t = plain(item.text)
      // A subtotal is the sum of items above it, not a part.
      if (SUBTOTAL.test(t.split(/[:–—]/)[0] ?? "")) continue
      const found = parseAmounts(t, { rupee })
      // An amount in the total's currency beats a bare scaled number ("27-inch 4K monitor — $349").
      const inCur = found.filter((a) => a.cur === T.cur)
      let own = inCur.length ? inCur : found.filter((a) => a.cur === null)
      // "Catering (400 guests × ₹1,500): ₹6 lakh": the item's price is the one amount after its label.
      const colon = Math.max(t.lastIndexOf(":"), t.lastIndexOf(" — "), t.lastIndexOf(" – "))
      if (own.length > 1 && colon > 0) {
        const after = own.filter((a) => a.start > colon)
        if (after.length === 1) own = after
      }
      if (own.length === 0) unpriced++
      else if (own.length > 1) ambiguous = true
      else priced.push({ item, amount: own[0] })
    }
    // "**Subtotal: $168.75**" right before "- Tax: $14.98  - Tip: $33.75", then "Total: $217.48": the list adds to it.
    const sub = block.before[0]
    if (sub && SUBTOTAL.test(plain(sub.text))) {
      const a = parseAmounts(plain(sub.text), { rupee }).filter((x) => x.cur === T.cur)
      if (a.length === 1) priced.unshift({ item: { line: sub.line, indent: 0, text: sub.text, raw: sub.text }, amount: a[0] })
    }
    if (ambiguous || priced.length < 2) continue
    // A price per day or per item can't be summed into a trip total.
    const totalRate = RATE.exec(plain(total.text))?.[0]?.toLowerCase()
    if (priced.some((p) => {
      const r = RATE.exec(plain(p.item.text))?.[0]?.toLowerCase()
      return !!r && r !== totalRate
    })) continue
    // Alternatives ("Budget: $30k", "Luxury: $65k") span the total instead of adding up to it.
    const minLo = Math.min(...priced.map((p) => p.amount.lo))
    const maxHi = Math.max(...priced.map((p) => p.amount.hi))
    if (close(minLo, T.lo, 0.05) && close(maxHi, T.hi, 0.05)) continue
    if (priced.filter((p) => ALTERNATIVES.test(plain(p.item.text).split(/[:–—-]/)[0] ?? "")).length >= 2) continue
    // A derivation, not a breakdown: items over different periods ("Monthly cost: $1,127", "Annual cost: $13,524",
    // then a discount and tax) are the steps of one calculation and can't be summed. (A total that equals only some
    // of the items is NOT exempted: that is exactly the "forgot one item" error.)
    const periods = new Set(priced.map((p) => periodWord(plain(p.item.text).split(/[:–—]/)[0] ?? "")).filter(Boolean))
    if (periods.size > 1) continue

    const parts = sum(priced.map((p) => p.amount))
    const prose = total.where !== "item" && !TOTAL_LABEL.test(plain(total.text))
    // A prose total far from the parts is probably about something else ("trips cost $40k; you can save: …").
    if (prose && (parts.hi > T.hi * 2.5 || parts.hi * 2.5 < T.lo)) continue
    // A prose total over a list that isn't called a breakdown may list only some parts ("key segments: …"):
    // then only parts that add up to MORE than the total are a contradiction.
    const breakdown = BREAKDOWN.test([...block.before.map((b) => b.text), total.text].join(" "))
    const exceeds = parts.lo > T.lo * 1.05 + 1 && parts.hi > T.hi * 1.05 + 1
    let verdict: "ok" | "mismatch" | "loose"
    if (unpriced) verdict = parts.lo > T.hi * 1.05 ? "mismatch" : "ok" // unpriced items: only "the parts already exceed the total" is certain
    else if (prose && !breakdown) verdict = exceeds ? "mismatch" : "ok"
    // Prose rounds, so 5%; but a total written to the unit ("£9,030") rounds nothing, so 2% as in tables.
    else verdict = compare(T, parts, !T.approx && T.precision < 0.005 ? 0.02 : 0.05)
    if (verdict === "ok") continue
    out.push({
      check: "list-total",
      severity: verdict === "loose" ? "hint" : "error",
      message:
        verdict === "loose"
          ? `The total "${T.text.trim()}" is a single figure inside what the ${priced.length} items span (${fmtRange(parts.lo, parts.hi, T.cur)}); say what it assumes.`
          : unpriced
            ? `The total "${T.text.trim()}${T.plus ? "+" : ""}" is less than its priced items alone (${fmtRange(parts.lo, parts.hi, T.cur)}).`
            : `The total "${T.text.trim()}${T.plus ? "+" : ""}" doesn't match its ${priced.length} items, which add up to ${fmtRange(parts.lo, parts.hi, T.cur)}.`,
      evidence: {
        excerpt: total.excerpt,
        line: total.line + 1,
        where: total.where,
        stated: { lo: T.lo, hi: T.hi, currency: T.cur },
        computed: { lo: parts.lo, hi: parts.hi },
        items: priced.map((p) => p.amount.text.trim()),
        unpriced,
      },
    })
  }
  return out
}
