/**
 * Money amounts in free text: "$15,000", "PKR 4.1 Cr", "₹41,50,000", "15k–25k", "$40–74k",
 * "between $30,000 and $65,000", "41.5–69.3 lakh". Built from the numbers prototype
 * (quality-research/numbers-proto.mjs) and its K2 shapes.
 *
 * Rules:
 * - An amount needs a currency marker, or a scale word that only money uses (lakh, crore, arab).
 *   "k" and "thousand/million/billion" count without a currency only as `kind: "scaled"`, and a
 *   bare "m" without a currency is metres, never millions. Years and counts are not amounts.
 * - "L" is lakh only on an amount marked as rupees ("PKR 4.5L", "₹14.4 L"); anywhere else it may be litres, and
 *   the amount is not read at all.
 * - A range's first half inherits the second half's scale and currency ("$40–74k" is 40k–74k),
 *   unless that would put the low end above the high end ("$500–2k" is 500–2,000).
 */

export type Amount = {
  lo: number
  hi: number
  /** ISO code ("USD", "PKR", "INR", "EUR", "GBP"), or null when the text names none. */
  cur: string | null
  /** "money": has a currency or a lakh/crore scale. "scaled": "15k–25k" with no currency. */
  kind: "money" | "scaled"
  range: boolean
  /** Written with ~, ≈, about, around, approx… in front. */
  approx: boolean
  /** Written with a trailing "+" ("$65,000+"). */
  plus: boolean
  /** Half a unit of the last significant digit shown, relative to the value: how much rounding the text allows. */
  precision: number
  text: string
  start: number
  end: number
}

export type ParseOptions = {
  /** Currency for amounts that carry none (a table column headed "USD"); bare numbers then count too. */
  currency?: string | null
  /** What "Rs", "₨", "rupees" and an unmarked lakh/crore amount mean here. Default "PKR". */
  rupee?: "PKR" | "INR"
}

const SCALE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
  arab: 1e9,
  arabs: 1e9,
  // Only on an amount marked as rupees (parseAmounts): "PKR 4.5L", "₹14.4 L".
  l: 1e5,
}
/** Scale words that are only ever money: an amount with one needs no currency. */
const MONEY_SCALE = new Set(["lakh", "lakhs", "lac", "lacs", "crore", "crores", "cr", "arab", "arabs"])
/** Scale words that mean something else without a currency next to them (metres, billions of people). */
const NEEDS_CURRENCY = new Set(["m", "b"])

const NUM = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`
const SCALE_RE = String.raw`(?:thousand|million|billion|lakhs?|lacs?|crores?|arabs?|mn|bn|cr|k|m|b|l)(?![a-z])`
const CUR_PRE = String.raw`(?:USD\s?\$|US\$|USD|PKR|INR|EUR|GBP|AED|SAR|Rs\.?|₨|₹|€|£|\$)`
const CUR_POST = String.raw`(?:USD|PKR|INR|EUR|GBP|AED|SAR|rupees?|dollars?|euros?)(?![a-z])`
const AMT = String.raw`(${CUR_PRE})?\s?(${NUM})(?:\s?(${SCALE_RE}))?(?:\s?(${CUR_POST}))?`
const SEP = String.raw`(\s*(?:–|—|‒|-|\bto\b|\buntil\b|\bthrough\b)\s*|\s+and\s+)`
const RANGE_RE = new RegExp(String.raw`(?<![\w.,])${AMT}(?:${SEP}${AMT})?`, "gid")
const APPROX_BEFORE = /(?:~|≈|∼|\babout|\baround|\bapprox(?:\.|imately)?|\broughly|\bnearly|\balmost|\bcirca|\best(?:imated)?\.?)\s*(?:of\s+)?$/i

function curOf(token: string | undefined, rupee: "PKR" | "INR"): string | null {
  if (!token) return null
  const t = token.toLowerCase().replace(/\s/g, "")
  if (t === "$" || t === "us$" || t === "usd" || t === "usd$" || t.startsWith("dollar")) return "USD"
  if (t === "pkr") return "PKR"
  if (t === "inr" || t === "₹") return "INR"
  if (t === "eur" || t === "€" || t.startsWith("euro")) return "EUR"
  if (t === "gbp" || t === "£") return "GBP"
  if (t === "rs" || t === "rs." || t === "₨" || t.startsWith("rupee")) return rupee
  return token.toUpperCase()
}

const toNumber = (s: string) => Number(s.replace(/,/g, ""))
/** 41.55 × 1e5 is 4154999.9999999995 in floating point; amounts are never that precise. */
const scaled = (n: string, scale: number) => Number((toNumber(n) * scale).toPrecision(12))

/** Half a unit of the last significant digit, as a share of the value ("1.1 Cr" → 0.045, "15,000" → 0.033). */
function precisionOf(numText: string, value: number, scale: number): number {
  if (!value) return 0
  const digits = numText.replace(/,/g, "")
  const dot = digits.indexOf(".")
  let half: number
  if (dot >= 0) half = 0.5 * 10 ** -(digits.length - dot - 1)
  else {
    const zeros = /0*$/.exec(digits)?.[0].length ?? 0
    // Trailing zeros may be rounding, but read at least two significant digits ("300,000" is not "anything from 250k to 350k").
    half = 0.5 * 10 ** Math.min(zeros, Math.max(digits.length - 2, 0))
  }
  return (half * scale) / Math.abs(value)
}

type Half = { cur: string | null; num: string; scaleWord: string | null }

/**
 * A minus sign written right against the amount ("-$18", "Discount: −PKR 500"), not after a word or number
 * ("$500-$200" is two amounts; "- $500" at a line's start is a bullet).
 */
function negativeAt(text: string, start: number): boolean {
  const m = text[start - 1]
  if (m !== "-" && m !== "−") return false
  const prev = text[start - 2]
  return prev === undefined ? start - 1 === 0 : !/[\w.,)\]%-]/.test(prev)
}

function negate(a: Amount): Amount {
  return { ...a, lo: -a.hi, hi: -a.lo }
}

/** Every amount or range in `text`, in order. */
export function parseAmounts(text: string, opts: ParseOptions = {}): Amount[] {
  const rupee = opts.rupee ?? "PKR"
  const out: Amount[] = []
  RANGE_RE.lastIndex = 0
  for (const m of text.matchAll(RANGE_RE)) {
    const [all, p1, n1, s1, q1, sep, p2, n2, s2, q2] = m
    const start = m.index ?? 0
    const first: Half = { cur: curOf(p1, rupee) ?? curOf(q1, rupee), num: n1, scaleWord: s1?.toLowerCase() ?? null }
    const second: Half | null = n2 ? { cur: curOf(p2, rupee) ?? curOf(q2, rupee), num: n2, scaleWord: s2?.toLowerCase() ?? null } : null
    // "L" is lakh only on an amount marked as rupees ("PKR 25.9L", "₹14.4 L"); elsewhere it may be litres, and the
    // amount is not read at all (never as 25.9 rupees).
    const rupeeMarked = [first.cur, second?.cur].some((c) => c === "PKR" || c === "INR")
    const dropFirst = first.scaleWord === "l" && !rupeeMarked
    const dropSecond = second?.scaleWord === "l" && !rupeeMarked
    const between = /\bbetween\s*$/i.test(text.slice(Math.max(0, start - 12), start))
    const isAnd = !!sep && /and/i.test(sep)
    const approx = APPROX_BEFORE.test(text.slice(Math.max(0, start - 16), start))

    const make = (h: Half, at: number, len: number): Amount | null => {
      let cur = h.cur
      const sw = h.scaleWord
      if (sw && NEEDS_CURRENCY.has(sw) && !cur && !opts.currency) return null
      if (!cur && sw && MONEY_SCALE.has(sw)) cur = rupee
      if (!cur && opts.currency) cur = opts.currency
      if (!cur && !sw) return null
      const scale = sw ? SCALE[sw] : 1
      const v = scaled(h.num, scale)
      const end = at + len
      const one: Amount = { lo: v, hi: v, cur, kind: cur ? "money" : "scaled", range: false, approx, plus: text[end] === "+", precision: precisionOf(h.num, v, scale), text: text.slice(at, end), start: at, end }
      return negativeAt(text, at) ? negate(one) : one
    }

    // "$20 – ₹1,660" is two amounts in two currencies, not a range.
    const twoCurrencies = !!first.cur && !!second?.cur && first.cur !== second.cur
    if (second && (!isAnd || between) && !twoCurrencies && !dropFirst && !dropSecond) {
      // Inherit the second half's scale and currency, unless the first half has its own or it would invert the range.
      const firstScale = first.scaleWord ? SCALE[first.scaleWord] : null
      const secondScale = second.scaleWord ? SCALE[second.scaleWord] : 1
      let loScale = firstScale ?? secondScale
      if (firstScale === null && toNumber(first.num) * loScale > toNumber(second.num) * secondScale) loScale = 1
      const cur = first.cur ?? second.cur
      const swAny = first.scaleWord ?? second.scaleWord
      const okWithoutCur = (swAny && MONEY_SCALE.has(swAny)) || (swAny && !NEEDS_CURRENCY.has(swAny)) || opts.currency
      if (cur || okWithoutCur) {
        const lo = scaled(first.num, loScale)
        const hi = scaled(second.num, secondScale)
        if (hi >= lo && !(swAny && NEEDS_CURRENCY.has(swAny) && !cur && !opts.currency)) {
          const resolved = cur ?? (swAny && MONEY_SCALE.has(swAny) ? rupee : (opts.currency ?? null))
          const end = start + all.length
          const r: Amount = {
            lo,
            hi,
            cur: resolved,
            kind: resolved ? "money" : "scaled",
            range: true,
            approx,
            plus: text[end] === "+",
            precision: Math.max(precisionOf(first.num, lo, loScale), precisionOf(second.num, hi, secondScale)),
            text: all,
            start,
            end,
          }
          out.push(negativeAt(text, start) ? negate(r) : r)
          continue
        }
      }
    }
    // Not a range: the halves are amounts on their own (each needs its own markers).
    const sepAt = m.indices?.[5]
    const firstEnd = second && sepAt ? sepAt[0] : start + all.length
    const a = dropFirst ? null : make(first, start, firstEnd - start)
    if (a) out.push(a)
    if (second && sepAt) {
      const b = dropSecond ? null : make(second, sepAt[1], start + all.length - sepAt[1])
      if (b) out.push(b)
    }
  }
  return out
}

/** Digits in `text` that no amount covers (footnote marks like [1] aside): a sign the text says more than one amount. */
export function hasStrayDigits(text: string, amounts: Amount[]): boolean {
  let rest = ""
  let at = 0
  for (const a of [...amounts].sort((x, y) => x.start - y.start)) {
    rest += text.slice(at, a.start)
    at = Math.max(at, a.end)
  }
  rest += text.slice(at)
  return /\d/.test(rest.replace(/\[\d+\]|\^\d+/g, ""))
}

// ------------------------------------------------------------------ formatting (for messages)

function group(n: number, indian: boolean): string {
  const neg = n < 0
  const [int, frac] = Math.abs(n).toFixed(Math.abs(n) < 100 && n % 1 ? 2 : 0).split(".")
  let g: string
  if (indian && int.length > 3) {
    const last3 = int.slice(-3)
    const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")
    g = `${rest},${last3}`
  } else g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${neg ? "-" : ""}${g}${frac && Number(frac) ? `.${frac}` : ""}`
}

const round = (n: number, places: number) => Number(n.toFixed(places))

/** "$21,500", "PKR 59.56 lakh", "PKR 1.14 crore", "€1,200". */
export function fmtMoney(v: number, cur: string | null): string {
  if (cur === "PKR" || cur === "INR") {
    const a = Math.abs(v)
    if (a >= 1e7) return `${cur} ${round(v / 1e7, 2)} crore`
    if (a >= 1e5) return `${cur} ${round(v / 1e5, 2)} lakh`
    return `${cur} ${group(v, true)}`
  }
  const sym = cur === "USD" ? "$" : cur === "EUR" ? "€" : cur === "GBP" ? "£" : ""
  return sym ? `${sym}${group(v, false)}` : `${group(v, false)}${cur ? ` ${cur}` : ""}`
}

export function fmtRange(lo: number, hi: number, cur: string | null): string {
  return lo === hi ? fmtMoney(lo, cur) : `${fmtMoney(lo, cur)} – ${fmtMoney(hi, cur)}`
}
