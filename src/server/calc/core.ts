/**
 * syrup_calc's core (docs/QUALITY.md Q3): exact arithmetic for the numbers an answer gives, so a model never adds,
 * converts or groups lakh/crore in its head. Pure and deterministic: no I/O, no clock, no `eval`. The MCP tool
 * (./tool.ts) feeds it an exchange-rate table when a line converts and none was given.
 *
 * One line per result, `name = expression`:
 *
 *   permit = 15k..25k USD          a range; k m bn lakh crore after a number; an ISO code after it
 *   gear = 5,000 – 10,000 USD      grouped numbers (1,500,000 or 15,00,000), – or .. or "to" for a range
 *   total = permit + gear          names from earlier lines; ranges add low to low, high to high
 *   fee = 18% of total             percentages: "p% of x", "x + p%", "x - p%"
 *   1 USD = 278.4 PKR              a rate to use (or "USD/PKR = 278.4")
 *   total_pkr = total in PKR       a conversion: at the line above's rate, or today's table
 *
 * Also: + - * / ^ ( ), × ÷, sum() min() max() avg() round(x, digits), `#` comments, `;` between lines.
 * Refused, never guessed: "L" (lakh or litre?), Rs/₨ (PKR or INR?), ¥ (JPY or CNY?), lowercase currency codes,
 * two currencies in one sum, a missing rate, division by zero or by a range through zero, |x| > 1e15.
 */

/** A single value (lo = hi) or a range; `aff` records which range literals a range came from (see Aff below). */
export type Value = { lo: number; hi: number; cur: string | null; pct: boolean; aff?: { c: number; t: Record<number, number> } }

/** Units of each currency per 1 USD, upper-case ISO codes. */
export type RateTable = { usd: Record<string, number>; date: string; source: string }

export type RateUsed = { from: string; to: string; rate: number; source: string }

export type CalcLine = { name: string; value: Value; shown: string }

export type CalcOk = { ok: true; lines: CalcLine[]; rates: RateUsed[]; text: string }
export type CalcErr = { ok: false; code: "parse" | "rate-missing" | "math" | "limit"; line: number | null; error: string; text: string }
export type CalcResult = CalcOk | CalcErr

export const LIMITS = { chars: 4000, lines: 60, tokensPerLine: 200, depth: 40, abs: 1e15, nameLength: 40 }

/** ISO 4217 codes (plus gold and silver). Upper case only: "try", "top", "all" and "cup" are words, not currencies. */
const ISO = new Set(
  (
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP " +
    "CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR " +
    "ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT " +
    "MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD " +
    "SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND " +
    "VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL XAU XAG"
  ).split(" "),
)
/** Currencies written with lakh and crore. */
const INDIAN = new Set(["PKR", "INR", "NPR", "BDT"])

const SCALES: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  thousand: 1e3,
  m: 1e6,
  M: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  B: 1e9,
  bn: 1e9,
  billion: 1e9,
  tn: 1e12,
  trillion: 1e12,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
  arab: 1e9,
}
const FUNCS = new Set(["sum", "min", "max", "avg", "round"])
/** Words that can't be names. Scale words can ("m", "b", "k"): they only scale a number written right before them. */
const WORDS = new Set(["of", "in", "to", "at", ...FUNCS])

// ------------------------------------------------------------------------------------------------ tokens

type Tok =
  | { k: "num"; v: number; text: string; scale: number }
  | { k: "id"; v: string }
  | { k: "cur"; v: string }
  | { k: "op"; v: string }
  | { k: "range" }
  | { k: "word"; v: "of" | "in" | "to" | "at" }

class CalcError extends Error {
  constructor(
    message: string,
    readonly code: CalcErr["code"] = "parse",
  ) {
    super(message)
  }
}

/** A short, printable piece of the input for an error message (never more than 24 characters of it). */
function snippet(s: string): string {
  const clean = s.replace(/[^\x20-\x7E -ɏ–—×÷]/g, "?").trim()
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean
}

const NUM_RE = /(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+(?:_\d+)*)(?:\.\d+)?(?:e[+-]?\d{1,3})?|\.\d+/y
const SCALE_RE = /\s?(thousand|million|billion|trillion|lakhs|lakh|lacs|lac|crores|crore|arab|mn|bn|tn|cr|k|K|m|M|b|B)(?![A-Za-z0-9_])/y
const ID_RE = /[A-Za-z_][A-Za-z0-9_]*/y
const SPACE_RE = /\s+/y

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const at = (re: RegExp) => {
    re.lastIndex = i
    return re.exec(src)
  }
  while (i < src.length) {
    if (out.length > LIMITS.tokensPerLine) throw new CalcError(`a line may hold at most ${LIMITS.tokensPerLine} numbers, names and signs`, "limit")
    const sp = at(SPACE_RE)
    if (sp) {
      i += sp[0].length
      continue
    }
    const c = src[i]
    const two = src.slice(i, i + 2)
    if (two === ".." || c === "–" || c === "—") {
      out.push({ k: "range" })
      i += two === ".." ? 2 : 1
      continue
    }
    const num = at(NUM_RE)
    if (num) {
      let text = num[0]
      let v = Number(text.replace(/[,_]/g, ""))
      i += text.length
      const sc = at(SCALE_RE)
      if (sc) {
        v *= SCALES[sc[1]]
        text += sc[0]
        i += sc[0].length
      } else if (/^\s?L(?![A-Za-z0-9_])/.test(src.slice(i))) {
        throw new CalcError(`"${snippet(text)} L" could be lakh or litres: write "lakh"`)
      }
      if (!Number.isFinite(v) || Math.abs(v) > LIMITS.abs) throw new CalcError(`"${snippet(text)}" is too large (the limit is 1e15)`, "limit")
      out.push({ k: "num", v: Number(v.toPrecision(15)), text: text.replace(/\s/g, ""), scale: sc ? SCALES[sc[1]] : 1 })
      // "15k-25k" with no spaces is almost always a range written with a hyphen, not 15k minus 25k.
      if (src[i] === "-" && /\d/.test(src[i + 1] ?? "")) {
        NUM_RE.lastIndex = i + 1
        const next = NUM_RE.exec(src)
        SCALE_RE.lastIndex = i + 1 + (next?.[0].length ?? 0)
        const nsc = next ? SCALE_RE.exec(src) : null
        const nv = next ? Number(next[0].replace(/[,_]/g, "")) * (nsc ? SCALES[nsc[1]] : 1) : NaN
        if (nv > v) throw new CalcError(`"${snippet(src.slice(i - num[0].length - (sc?.[0].length ?? 0), i + 1 + (next?.[0].length ?? 0) + (nsc?.[0].length ?? 0)))}" reads as a subtraction: write a range as 15k..25k, or put spaces around "-" to subtract`)
      }
      continue
    }
    if (src.startsWith("US$", i)) {
      out.push({ k: "cur", v: "USD" })
      i += 3
      continue
    }
    if (c === "$" || c === "€" || c === "£" || c === "₹") {
      out.push({ k: "cur", v: c === "$" ? "USD" : c === "€" ? "EUR" : c === "£" ? "GBP" : "INR" })
      i++
      continue
    }
    if (c === "₨" || c === "¥") throw new CalcError(c === "₨" ? `"₨" could be PKR or INR: write the ISO code` : `"¥" could be JPY or CNY: write the ISO code`)
    const id = at(ID_RE)
    if (id) {
      const w = id[0]
      i += w.length
      if (w === "Rs" || w === "rs" || w === "RS") {
        if (src[i] === ".") i++
        throw new CalcError(`"Rs" could be PKR or INR: write the ISO code`)
      }
      if (ISO.has(w)) out.push({ k: "cur", v: w })
      else if (w === "of" || w === "in" || w === "to" || w === "at") out.push({ k: "word", v: w })
      else if (w.length > LIMITS.nameLength) throw new CalcError(`a name may be at most ${LIMITS.nameLength} characters`, "limit")
      else out.push({ k: "id", v: w })
      continue
    }
    if ("+-*/^(),%×÷".includes(c)) {
      out.push({ k: "op", v: c === "×" ? "*" : c === "÷" ? "/" : c })
      i++
      continue
    }
    if (c === "−") {
      out.push({ k: "op", v: "-" })
      i++
      continue
    }
    throw new CalcError(`can't read "${snippet(src.slice(i))}"`)
  }
  // "15..25k" and "$40–74k": the low end takes the high end's scale, unless that would put it above the high end.
  for (let k = 0; k + 2 < out.length; k++) {
    const a = out[k]
    const b = out[k + 2]
    if (a.k === "num" && out[k + 1].k === "range" && b.k === "num" && a.scale === 1 && b.scale > 1 && a.v * b.scale <= b.v)
      out[k] = { ...a, v: Number((a.v * b.scale).toPrecision(15)), scale: b.scale }
  }
  return out
}

// ------------------------------------------------------------------------------------------------ interval arithmetic

const V = (lo: number, hi = lo, cur: string | null = null, pct = false): Value => ({ lo, hi, cur, pct })

/*
 * Ranges remember where they came from (affine arithmetic): value = c + Σ t[id]·ε_id, each ε_id anywhere in [-1, 1],
 * one id per range literal. So "permit − 10% of permit" is 13,500 – 22,500, not the 12,500 – 23,500 plain interval
 * rules give, and "a − a" is 0 (review 2026-10-11). Sums, differences and scaling by a single number stay exact. A
 * product or quotient of two ranges is exact when both come from the same single range, and otherwise uses the plain
 * interval rule (wider than the truth, never narrower) and starts a new source.
 */
type Aff = { c: number; t: Record<number, number> }
let nextSource = 1

/** A range that somehow carries no record counts as a source of its own (wider, never narrower). */
const affOf = (v: Value): Aff => v.aff ?? (v.lo === v.hi ? { c: v.lo, t: {} } : { c: (v.lo + v.hi) / 2, t: { [nextSource++]: (v.hi - v.lo) / 2 } })

function fromAff(a: Aff, cur: string | null, pct: boolean): Value {
  const t: Record<number, number> = {}
  let r = 0
  for (const k of Object.keys(a.t)) {
    const x = a.t[Number(k)]
    if (Math.abs(x) <= Math.abs(a.c) * 1e-12 || x === 0) continue
    t[Number(k)] = x
    r += Math.abs(x)
  }
  return checked(r ? { lo: a.c - r, hi: a.c + r, cur, pct, aff: { c: a.c, t } } : V(a.c, a.c, cur, pct))
}

/** A range with a source of its own: a literal, or the result of a step that can't keep track exactly. */
function fresh(lo: number, hi: number, cur: string | null, pct: boolean): Value {
  if (lo === hi) return checked(V(lo, hi, cur, pct))
  return checked({ lo, hi, cur, pct, aff: { c: (lo + hi) / 2, t: { [nextSource++]: (hi - lo) / 2 } } })
}

function linear(a: Aff, b: Aff, sign: 1 | -1): Aff {
  const t: Record<number, number> = { ...a.t }
  for (const k of Object.keys(b.t)) t[Number(k)] = (t[Number(k)] ?? 0) + sign * b.t[Number(k)]
  return { c: a.c + sign * b.c, t }
}

function scaled(v: Value, k: number, cur: string | null, pct: boolean): Value {
  const a = affOf(v)
  const t: Record<number, number> = {}
  for (const key of Object.keys(a.t)) t[Number(key)] = a.t[Number(key)] * k
  return fromAff({ c: a.c * k, t }, cur, pct)
}

/** The one source both values hang on, with their spreads, when that is all they hang on. */
function oneSource(a: Value, b: Value): { ca: number; ra: number; cb: number; rb: number } | null {
  if (!a.aff || !b.aff) return null
  const ka = Object.keys(a.aff.t)
  const kb = Object.keys(b.aff.t)
  if (ka.length !== 1 || kb.length !== 1 || ka[0] !== kb[0]) return null
  return { ca: a.aff.c, ra: a.aff.t[Number(ka[0])], cb: b.aff.c, rb: b.aff.t[Number(kb[0])] }
}

function checked(v: Value): Value {
  for (const x of [v.lo, v.hi]) {
    if (!Number.isFinite(x)) throw new CalcError("the result is not a finite number", "math")
    if (Math.abs(x) > LIMITS.abs) throw new CalcError(`a result above ${LIMITS.abs.toExponential(0)} is out of range`, "limit")
  }
  // Floating-point dust (0.1 + 0.2): 15 significant digits are more than any money has.
  return { ...v, lo: Number(v.lo.toPrecision(15)) || 0, hi: Number(v.hi.toPrecision(15)) || 0 }
}

/** The currency of a sum: both the same, or one side a plain number that takes the other's. */
function sameCur(a: Value, b: Value, what: string): string | null {
  if (a.cur && b.cur && a.cur !== b.cur) throw new CalcError(`${what} mixes ${a.cur} and ${b.cur}: convert one first ("x in ${a.cur}")`, "math")
  return a.cur ?? b.cur
}

const add = (a: Value, b: Value): Value => fromAff(linear(affOf(a), affOf(b), 1), sameCur(a, b, "a sum"), a.pct && b.pct)
const sub = (a: Value, b: Value): Value => fromAff(linear(affOf(a), affOf(b), -1), sameCur(a, b, "a difference"), a.pct && b.pct)

function mul(a: Value, b: Value): Value {
  if (a.cur && b.cur)
    throw new CalcError(`can't multiply ${a.cur} by ${b.cur}: to convert, write "x in ${b.cur} at <rate>" or a line "1 ${a.cur} = <rate> ${b.cur}"`, "math")
  const cur = a.cur ?? b.cur
  // "5% * 2" stays a percentage; "18% * 100 USD" is money.
  const pct = (a.pct && !b.pct && !b.cur) || (b.pct && !a.pct && !a.cur)
  if (a.lo === a.hi) return scaled(b, a.lo, cur, pct)
  if (b.lo === b.hi) return scaled(a, b.lo, cur, pct)
  const s = oneSource(a, b)
  if (s) {
    // (ca + ra·ε)(cb + rb·ε) on ε ∈ [-1, 1]: both ends, and the vertex when it falls inside.
    const f = (e: number) => (s.ca + s.ra * e) * (s.cb + s.rb * e)
    const xs = [f(-1), f(1)]
    const v = -(s.ca * s.rb + s.cb * s.ra) / (2 * s.ra * s.rb)
    if (v > -1 && v < 1) xs.push(f(v))
    return fresh(Math.min(...xs), Math.max(...xs), cur, pct)
  }
  const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi]
  return fresh(Math.min(...p), Math.max(...p), cur, pct)
}

function div(a: Value, b: Value): Value {
  if (b.lo <= 0 && b.hi >= 0) throw new CalcError(b.lo === b.hi ? "division by zero" : "division by a range that includes zero", "math")
  if (b.cur && a.cur && a.cur !== b.cur) throw new CalcError(`can't divide ${a.cur} by ${b.cur}: convert one first`, "math")
  if (b.cur && !a.cur) throw new CalcError(`can't divide a plain number by ${b.cur}`, "math")
  const cur = b.cur ? null : a.cur
  const pct = a.pct && !b.pct && !b.cur
  if (b.lo === b.hi) return scaled(a, 1 / b.lo, cur, pct)
  const s = oneSource(a, b)
  if (s) {
    // (ca + ra·ε) / (cb + rb·ε) is monotone in ε while the divisor keeps its sign (checked above): its ends.
    const xs = [(s.ca - s.ra) / (s.cb - s.rb), (s.ca + s.ra) / (s.cb + s.rb)]
    return fresh(Math.min(...xs), Math.max(...xs), cur, pct)
  }
  const p = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi]
  return fresh(Math.min(...p), Math.max(...p), cur, pct)
}

function pow(a: Value, b: Value): Value {
  if (b.lo !== b.hi) throw new CalcError("an exponent must be a single number, not a range", "math")
  if (b.cur) throw new CalcError(`an exponent can't be in ${b.cur}`, "math")
  const e = b.lo
  if (Math.abs(e) > 1000) throw new CalcError("an exponent above 1000 is out of range", "limit")
  if (!Number.isInteger(e) && a.lo < 0) throw new CalcError("a negative number to a fractional power", "math")
  if (e < 0 && a.lo <= 0 && a.hi >= 0) throw new CalcError("division by zero", "math")
  const c = [a.lo ** e, a.hi ** e]
  if (a.lo < 0 && a.hi > 0 && e > 0) c.push(0)
  // "(10%)^2" is 1%.
  return fresh(Math.min(...c), Math.max(...c), a.cur, a.pct)
}

// ------------------------------------------------------------------------------------------------ parser

type Scope = Record<string, Value>

/** Recursive descent over one expression. Precedence, loosest first: + -, * / of, ^, range, unary -, %, atom. */
function evaluate(toks: Tok[], scope: Scope): Value {
  let i = 0
  let depth = 0
  const peek = () => toks[i]
  const isOp = (v: string) => {
    const t = toks[i]
    return !!t && t.k === "op" && t.v === v
  }
  const deeper = () => {
    if (++depth > LIMITS.depth) throw new CalcError(`brackets nested deeper than ${LIMITS.depth}`, "limit")
  }

  const atom = (): Value => {
    const t = toks[i++]
    if (!t) throw new CalcError("the expression ends too early")
    if (t.k === "cur") {
      // "$15k", "€1,200": a currency sign or code in front of a number.
      const n = toks[i]
      if (n?.k !== "num") throw new CalcError(`${t.v} must stand next to a number`)
      i++
      return V(n.v, n.v, t.v)
    }
    if (t.k === "num") return V(t.v)
    if (t.k === "op" && t.v === "(") {
      deeper()
      const v = sum()
      depth--
      if (!isOp(")")) throw new CalcError(`missing ")"`)
      i++
      return v
    }
    if (t.k === "id") {
      if (FUNCS.has(t.v) && isOp("(")) {
        i++
        deeper()
        const args: Value[] = []
        if (!isOp(")"))
          for (;;) {
            args.push(sum())
            if (isOp(",")) {
              i++
              continue
            }
            break
          }
        depth--
        if (!isOp(")")) throw new CalcError(`missing ")" after ${t.v}(…`)
        i++
        return call(t.v, args)
      }
      if (WORDS.has(t.v)) throw new CalcError(`"${t.v}" can't be used as a name`)
      if (!Object.hasOwn(scope, t.v)) throw new CalcError(`unknown name "${t.v}"${/^[a-z]{3}$/.test(t.v) && ISO.has(t.v.toUpperCase()) ? ` (currency codes are upper case: ${t.v.toUpperCase()})` : ""}`)
      return scope[t.v]
    }
    if (t.k === "op") throw new CalcError(`unexpected "${t.v}"`)
    if (t.k === "word") throw new CalcError(`unexpected "${t.v}"`)
    throw new CalcError("unexpected range sign")
  }

  /** An atom with what may follow it directly: a currency code ("15k USD") and a percent sign. */
  const postfix = (): Value => {
    let v = atom()
    const t = peek()
    if (t?.k === "cur") {
      i++
      if (v.cur && v.cur !== t.v) throw new CalcError(`a value in ${v.cur} can't also be ${t.v}: write "in ${t.v}" to convert`)
      v = { ...v, cur: t.v }
    }
    if (isOp("%")) {
      i++
      if (v.cur) throw new CalcError(`a percentage can't be in ${v.cur}`)
      v = scaled(v, 0.01, null, true)
    }
    return v
  }

  const unary = (): Value => {
    if (isOp("-")) {
      i++
      deeper()
      const v = unary()
      depth--
      return scaled(v, -1, v.cur, v.pct)
    }
    if (isOp("+")) {
      i++
      return unary()
    }
    return postfix()
  }

  /** "15k..25k", "15,000 – 25,000", "15k to 25k": low and high. A trailing currency covers both ends. */
  const range = (): Value => {
    const a = unary()
    const t = peek()
    const sep = t?.k === "range" || (t?.k === "word" && t.v === "to" && toks[i + 1]?.k !== "cur")
    if (!sep) return a
    i++
    let b = unary()
    if (a.lo !== a.hi || b.lo !== b.hi) throw new CalcError("a range's ends must be single values")
    const cur = sameCur(a, b, "a range")
    // "5..8%": both ends are percentages.
    let lo = a
    if (b.pct && !lo.pct && !lo.cur) lo = V(lo.lo / 100, lo.hi / 100, null, true)
    if (lo.pct && !b.pct && !b.cur) b = V(b.lo / 100, b.hi / 100, null, true)
    if (lo.pct !== b.pct) throw new CalcError("a range can't run from a percentage to an amount")
    return fresh(Math.min(lo.lo, b.lo), Math.max(lo.hi, b.hi), cur, lo.pct)
  }

  const power = (): Value => {
    const a = range()
    if (!isOp("^")) return a
    i++
    deeper()
    const b = power()
    depth--
    return pow(a, b)
  }

  const product = (): Value => {
    let v = power()
    for (;;) {
      const t = peek()
      if (t?.k === "op" && (t.v === "*" || t.v === "/")) {
        i++
        v = t.v === "*" ? mul(v, power()) : div(v, power())
      } else if (t?.k === "word" && t.v === "of") {
        // "18% of total"
        i++
        v = mul(v, power())
      } else return v
    }
  }

  const sum = (): Value => {
    let v = product()
    for (;;) {
      const t = peek()
      if (t?.k !== "op" || (t.v !== "+" && t.v !== "-")) return v
      i++
      const r = product()
      // "price + 18%" is price × 1.18; "5% + 3%" is 8%.
      if (r.pct && !v.pct) v = mul(v, V(t.v === "+" ? 1 + r.lo : 1 - r.hi, t.v === "+" ? 1 + r.hi : 1 - r.lo))
      else v = t.v === "+" ? add(v, r) : sub(v, r)
    }
  }

  const v = sum()
  if (i < toks.length) {
    const t = toks[i]
    const n = toks[i + 1]
    if (t.k === "word" && (t.v === "in" || t.v === "to") && n?.k === "id" && /^[A-Za-z]{3}$/.test(n.v) && i + 2 === toks.length) throw new CalcError(`"${n.v}" is not a currency code (use an ISO code such as PKR, INR, USD, EUR)`)
    if (t.k === "word" && t.v === "in") throw new CalcError(`"in" converts a whole line: write it at the end ("name = x in PKR")`)
    if (t.k === "id" && /^[a-z]{3}$/.test(t.v) && ISO.has(t.v.toUpperCase())) throw new CalcError(`unexpected "${t.v}" (currency codes are upper case: ${t.v.toUpperCase()})`)
    throw new CalcError(`unexpected "${t.k === "num" ? t.text : t.k === "range" ? "–" : t.v}"`)
  }
  return v
}

function call(name: string, args: Value[]): Value {
  if (!args.length) throw new CalcError(`${name}() needs at least one value`)
  if (name === "sum") return args.reduce(add)
  if (name === "avg") return div(args.reduce(add), V(args.length))
  if (name === "min" || name === "max") {
    const cur = args.reduce<string | null>((c, a) => sameCur(V(0, 0, c), a, `${name}()`), null)
    const f = name === "min" ? Math.min : Math.max
    return fresh(f(...args.map((a) => a.lo)), f(...args.map((a) => a.hi)), cur, args.every((a) => a.pct))
  }
  // round(x) or round(x, digits): digits may be negative (round(41_55_432, -3) is 41,55,000).
  const [x, d = V(0)] = args
  if (args.length > 2 || d.lo !== d.hi || !Number.isInteger(d.lo) || Math.abs(d.lo) > 12) throw new CalcError("round(x, digits) takes a value and a whole number of digits")
  const f = 10 ** d.lo
  // Half away from zero, like the display (round(-2.5) is -3, round(2.345, 2) is 2.35).
  const r = (n: number) => (Math.sign(n) * Math.round(Math.abs(n) * f + 1e-9)) / f
  return fresh(r(x.lo), r(x.hi), x.cur, x.pct)
}

// ------------------------------------------------------------------------------------------------ formatting

function group(int: string, indian: boolean): string {
  if (indian && int.length > 3) return `${int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${int.slice(-3)}`
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** Rounds half away from zero to `places` decimals and drops "-0". */
function fixed(n: number, places: number): string {
  const f = 10 ** places
  const r = (Math.sign(n) * Math.round(Math.abs(n) * f + 1e-9)) / f
  return (Object.is(r, -0) ? 0 : r).toFixed(places)
}

/** "41,55,000", "2,380,000", "1,234.50", "0.0825". Money keeps cents below 100,000; plain numbers up to 4 decimals. */
export function formatNumber(n: number, cur: string | null): string {
  const a = Math.abs(n)
  let s: string
  // Cents decided with the same epsilon fixed() rounds with: 1.005 USD shows 1.01, not 1.
  if (cur) s = fixed(n, a < 1e5 && Math.round(a * 100 + 1e-9) % 100 !== 0 ? 2 : 0)
  else if (a !== 0 && a < 0.01) s = Number(n.toPrecision(4)).toString()
  else s = fixed(n, 4).replace(/\.?0+$/, "")
  if (/e/.test(s)) return s
  const neg = s.startsWith("-")
  const [int, frac] = (neg ? s.slice(1) : s).split(".")
  return `${neg ? "-" : ""}${group(int, !!cur && INDIAN.has(cur))}${frac ? `.${frac}` : ""}`
}

const trim2 = (n: number) => fixed(n, 2).replace(/\.?0+$/, "")

/** "41.55 lakh", "1.14 crore", "2.38 million"; null below a lakh (Indian) or a million (others). */
function words(n: number, cur: string | null): string | null {
  const a = Math.abs(n)
  if (cur && INDIAN.has(cur)) {
    if (a >= 1e7) return `${trim2(n / 1e7)} crore`
    if (a >= 1e5) return `${trim2(n / 1e5)} lakh`
    return null
  }
  if (a >= 1e9) return `${trim2(n / 1e9)} billion`
  if (a >= 1e6) return `${trim2(n / 1e6)} million`
  return null
}

/** One value as the model should copy it: "41,55,000 – 69,25,000 PKR (41.55 – 69.25 lakh)", "18%", "2.5". */
export function formatValue(v: Value): string {
  if (v.pct) return v.lo === v.hi ? `${trim4(v.lo * 100)}%` : `${trim4(v.lo * 100)}% – ${trim4(v.hi * 100)}%`
  const range = v.lo !== v.hi
  const nums = range ? `${formatNumber(v.lo, v.cur)} – ${formatNumber(v.hi, v.cur)}` : formatNumber(v.lo, v.cur)
  const unit = v.cur ? ` ${v.cur}` : ""
  const wl = words(v.lo, v.cur)
  const wh = range ? words(v.hi, v.cur) : null
  let w = ""
  if (!range && wl) w = ` (${wl})`
  else if (range && (wl || wh)) {
    const sameUnit = wl && wh && wl.split(" ")[1] === wh.split(" ")[1]
    w = sameUnit ? ` (${wl.split(" ")[0]} – ${wh})` : ` (${wl ?? formatNumber(v.lo, v.cur)} – ${wh ?? formatNumber(v.hi, v.cur)})`
  }
  return `${nums}${unit}${w}`
}
const trim4 = (n: number) => fixed(n, 4).replace(/\.?0+$/, "")

/** A rate as people write it: 278.4, 0.8925, 0.0036. */
function formatRate(r: number): string {
  if (r >= 100) return trim2(r)
  if (r >= 1) return fixed(r, 4).replace(/\.?0+$/, "")
  return Number(r.toPrecision(4)).toString()
}

// ------------------------------------------------------------------------------------------------ lines

const NAME = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.*)$/
/** "1 USD = 278.4 PKR", "USD/PKR = 278.4", "USD to PKR = 278.4". */
/** Names that hold an exchange rate: "rate", "fx", "exchange_rate", "usd_pkr", "pkr_rate"; not "tax_rate" or "growth_rate". */
const RATE_NAME = /^(?:rate|fx|xr)$|exchange|conversion|^fx_|_fx$|(?:usd|pkr|inr|eur|gbp|aed)_?(?:to_?)?(?:usd|pkr|inr|eur|gbp|aed)|^(?:usd|pkr|inr|eur|gbp|aed)_?rate$|^rate_?(?:usd|pkr|inr|eur|gbp|aed)/i

const RATE_LINE = [
  /^1\s*([A-Z]{3})\s*=\s*([\d.,]+)\s*([A-Z]{3})$/,
  /^([A-Z]{3})\s*(?:\/|to)\s*([A-Z]{3})\s*=\s*([\d.,]+)$/,
  // "rate = 280 PKR per USD", "fx = 280 PKR/USD", "280 PKR per USD"
  /^(?:[A-Za-z_]\w*\s*=\s*)?([\d.,]+)\s*([A-Z]{3})\s*(?:per|\/|for each|for every|to (?:the|a|1|one))\s*(?:1\s*|one\s*)?([A-Z]{3})$/,
]

function splitLines(src: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = []
  src.split(/\r?\n/).forEach((raw, k) => {
    // Code fences and list bullets a model may wrap its lines in; # and // comments.
    if (/^\s*```/.test(raw)) return
    const noComment = raw.replace(/\s(?:#|\/\/).*$/, "").replace(/^\s*(?:#|\/\/).*$/, "")
    for (const part of noComment.split(";")) {
      const text = part.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").replace(/`/g, "").trim()
      if (text) out.push({ n: k + 1, text })
    }
  })
  return out
}

function parseRate(text: string): { from: string; to: string; rate: number } | null {
  let m = RATE_LINE[0].exec(text)
  if (m) return { from: m[1], to: m[3], rate: Number(m[2].replace(/,/g, "")) }
  m = RATE_LINE[1].exec(text)
  if (m) return { from: m[1], to: m[2], rate: Number(m[3].replace(/,/g, "")) }
  m = RATE_LINE[2].exec(text)
  if (m) return { from: m[3], to: m[2], rate: Number(m[1].replace(/,/g, "")) }
  return null
}

/**
 * Runs every line. `table` is today's rates (units per USD); without one, a conversion with no rate line fails with
 * code "rate-missing" so the caller can fetch the table and run again. The text is what the tool returns.
 */
export function calc(src: string, opts: { table?: RateTable | null } = {}): CalcResult {
  const fail = (code: CalcErr["code"], line: number | null, error: string): CalcErr => ({
    ok: false,
    code,
    line,
    error,
    text: `Error${line ? ` on line ${line}` : ""}: ${error}. Nothing was computed; fix that line and call again.`,
  })
  if (typeof src !== "string" || !src.trim()) return fail("parse", null, 'no lines: write one calculation per line, e.g. "total = 15k..25k USD + 5k USD"')
  if (src.length > LIMITS.chars) return fail("limit", null, `at most ${LIMITS.chars} characters`)
  const lines = splitLines(src)
  if (lines.length > LIMITS.lines) return fail("limit", null, `at most ${LIMITS.lines} lines`)

  nextSource = 1
  const scope: Scope = Object.create(null)
  const given: Record<string, number> = Object.create(null)
  const used = new Map<string, RateUsed>()
  const out: CalcLine[] = []
  let unnamed = 0

  const givenRate = (from: string, to: string): RateUsed | null => {
    if (given[`${from}/${to}`]) return { from, to, rate: given[`${from}/${to}`], source: "your rate" }
    if (given[`${to}/${from}`]) return { from, to, rate: 1 / given[`${to}/${from}`], source: "your rate" }
    return null
  }
  /**
   * Models write the user's rate as a value: "rate = 280 PKR", "usd_pkr_rate = 280". Never let today's table
   * silently replace it: use it when it can only mean one thing, else refuse with the line to write instead.
   */
  const namedRate = (from: string, to: string): RateUsed | null => {
    const named = Object.keys(scope).filter((k) => RATE_NAME.test(k) && scope[k].lo === scope[k].hi && !scope[k].pct && (scope[k].cur === to || scope[k].cur === null))
    if (!named.length) return null
    const how = (r: number) => `write "1 ${from} = ${formatRate(r)} ${to}" or "x in ${to} at ${formatRate(r)}"`
    if (named.length > 1) throw new CalcError(`several values look like rates (${named.join(", ")}): ${how(scope[named[0]].lo)} with the one to use`)
    const x = scope[named[0]]
    const others = new Set(Object.values(scope).map((s) => s.cur).filter((c) => c && c !== from && c !== to))
    if (x.cur === to && !others.size && x.lo > 0) return { from, to, rate: x.lo, source: `your rate, from "${named[0]}"` }
    throw new CalcError(`"${named[0]}" can't be used as the ${from}→${to} rate as written: ${how(x.lo)}`)
  }
  const rateFor = (from: string, to: string): RateUsed | null => {
    const mine = givenRate(from, to)
    if (mine) return mine
    const t = opts.table?.usd
    if (t && (from === "USD" || t[from]) && (to === "USD" || t[to])) {
      const r = (to === "USD" ? 1 : t[to]) / (from === "USD" ? 1 : t[from])
      if (Number.isFinite(r) && r > 0) return { from, to, rate: r, source: `${opts.table!.source}, ${opts.table!.date}` }
    }
    return null
  }

  // Rate lines apply to every line, wherever they stand ("total_pkr = total in PKR" before "1 USD = 278 PKR" still
  // uses 278, never today's table). Two rates for one pair: the later line wins.
  for (const { n, text } of lines) {
    const rate = parseRate(text)
    if (!rate) continue
    let problem: string | null = null
    for (const c of [rate.from, rate.to]) if (!ISO.has(c)) problem ??= `"${c}" is not a currency code`
    if (!(rate.rate > 0) || !Number.isFinite(rate.rate) || rate.rate > LIMITS.abs) problem ??= "a rate must be a positive number"
    if (rate.from === rate.to) problem ??= "a rate needs two different currencies"
    if (problem) return fail("parse", n, problem)
    given[`${rate.from}/${rate.to}`] = rate.rate
    delete given[`${rate.to}/${rate.from}`]
  }

  for (const { n, text } of lines) {
    try {
      if (parseRate(text)) continue
      const m = NAME.exec(text)
      let name: string
      let expr: string
      if (m) {
        name = m[1]
        expr = m[2]
        if (WORDS.has(name) || ISO.has(name)) throw new CalcError(`"${name}" can't be used as a name`)
        if (name.length > LIMITS.nameLength) throw new CalcError(`a name may be at most ${LIMITS.nameLength} characters`, "limit")
        if (!expr.trim()) throw new CalcError(`"${name} =" has nothing after it`)
      } else {
        name = ""
        expr = text
      }
      let toks = tokenize(expr)
      // A conversion at the end: "… in PKR", "… to PKR", optionally "at 278.4".
      let convert: { to: string; at: number | null } | null = null
      const last = toks.length - 1
      if (last >= 1 && toks[last].k === "cur" && toks[last - 1].k === "word" && ["in", "to"].includes((toks[last - 1] as { v: string }).v)) {
        convert = { to: (toks[last] as { v: string }).v, at: null }
        toks = toks.slice(0, last - 1)
      } else if (last >= 3 && toks[last].k === "num" && toks[last - 1].k === "word" && (toks[last - 1] as { v: string }).v === "at" && toks[last - 2].k === "cur" && toks[last - 3].k === "word") {
        const w = (toks[last - 3] as { v: string }).v
        if (w === "in" || w === "to") {
          convert = { to: (toks[last - 2] as { v: string }).v, at: (toks[last] as { v: number }).v }
          toks = toks.slice(0, last - 3)
        }
      } else if (last >= 2 && toks[last].k === "cur" && toks[last - 1].k === "num" && toks[last - 2].k === "word" && ["in", "at"].includes((toks[last - 2] as { v: string }).v)) {
        // "total in 280 PKR", "total at 280 PKR": the number is the rate. ("15k to 25k USD" is a range, not this.)
        convert = { to: (toks[last] as { v: string }).v, at: (toks[last - 1] as { v: number }).v }
        toks = toks.slice(0, last - 2)
      }
      if (!toks.length) throw new CalcError("there is nothing to compute")
      let v = evaluate(toks, scope)
      if (convert) {
        if (v.pct) throw new CalcError("a percentage has no currency to convert")
        if (!v.cur) throw new CalcError(`the value has no currency to convert to ${convert.to}: give its code ("15k USD")`)
        if (v.cur !== convert.to) {
          let r: RateUsed | null
          if (convert.at !== null) {
            if (!(convert.at > 0)) throw new CalcError("a rate must be a positive number")
            r = { from: v.cur, to: convert.to, rate: convert.at, source: "your rate" }
          } else r = givenRate(v.cur, convert.to) ?? namedRate(v.cur, convert.to) ?? rateFor(v.cur, convert.to)
          if (!r) {
            const err = new CalcError(
              opts.table === undefined
                ? `no ${v.cur}→${convert.to} rate yet`
                : `no ${v.cur}→${convert.to} rate: today's rates could not be fetched${opts.table ? ` or don't list ${[v.cur, convert.to].filter((c) => c !== "USD" && !opts.table?.usd[c]).join(" and ") || "it"}` : ""}. Add a line "1 ${v.cur} = <rate> ${convert.to}" with a rate from a source you name, or ask the user`,
              "rate-missing",
            )
            throw err
          }
          used.set(`${r.from}/${r.to}/${r.source}`, r)
          v = scaled(v, r.rate, convert.to, false)
        }
      }
      if (!name) name = `#${++unnamed}`
      else scope[name] = v
      out.push({ name, value: v, shown: formatValue(v) })
    } catch (err) {
      if (err instanceof CalcError) return fail(err.code, n, err.message)
      throw err
    }
  }
  if (!out.length) return fail("parse", null, "no calculations, only rates")

  const rates = [...used.values()]
  const text = [
    "Exact results (copy them as written):",
    ...out.map((l) => `${l.name} = ${l.shown}`),
    ...rates.map((r) => `Rate used: 1 ${r.from} = ${formatRate(r.rate)} ${r.to} (${r.source})`),
  ].join("\n")
  return { ok: true, lines: out, rates, text }
}
