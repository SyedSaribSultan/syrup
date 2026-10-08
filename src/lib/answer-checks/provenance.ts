/**
 * Where an answer's numbers came from, checked against what the agent read (tool inputs and
 * outputs) and what the user said. Deterministic and soft: a number not found is a warning,
 * never an error, because a correct answer may round or derive.
 *
 * - provenance: every money amount (both ends of a range) is looked up in the sources.
 *   Found → fine. Found, but not in the page the same line links to → hint ("from another source").
 *   Not found → warning, unless the line says it is a calculation (≈, about, total, estimate,
 *   a conversion next to its USD figure) → one "calculated" hint per answer. Found only in the
 *   chat's earlier answers → one hint per answer (the earlier answer carries the warning).
 * - label: a number next to "full board" / "base camp" / "per team"… whose occurrences in the
 *   sources never have that phrase within 200 characters, while the sources do use it elsewhere.
 *   Catches some relabelled ranges; a hint only.
 * - claim: "X is not discounted" style blanket claims whose key word appears in no page read.
 *   A hint only; whether a page supports a claim needs a judge.
 */
import { mdLines, plain } from "./markdown"
import { fmtRange, parseAmounts, type Amount } from "./money"
import { TOTAL_LABEL } from "./totals"
import { citedLinks, normalizeUrl } from "./urls"
import type { Finding, Source } from "./types"

export type ProvenanceOptions = {
  sources: Source[]
  /** Earlier user messages and answers in the same chat. */
  earlier?: string[]
  rupee?: "PKR" | "INR"
}

const CALCULATED = /≈|~|∼|\babout\b|\baround\b|\broughly\b|\bapprox|\bestimat|\bin total\b|\btotal\b|\ball[- ]in\b|\bsum\b|\bcombined\b|\bconvert|\bcalculat|\bexpect|\bbudget\b|\bat (?:the )?(?:current )?(?:exchange )?rate\b/i

const NUM_IN_SOURCE = /(?<![\w.])(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(thousand|million|billion|lakhs?|lacs?|crores?|mn|bn|cr|k|m|b)(?![a-z]))?/gi
const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, mn: 1e6, bn: 1e9, cr: 1e7, k: 1e3, m: 1e6, b: 1e9 }

const key = (v: number) => Number(v.toPrecision(6))

type Hit = { source: number; pos: number }

/** value → where it appears. Each number is indexed as written and with its scale applied ("28k" → 28 and 28,000). */
function indexNumbers(texts: string[]): Map<number, Hit[]> {
  const idx = new Map<number, Hit[]>()
  const add = (v: number, hit: Hit) => {
    if (!Number.isFinite(v)) return
    const k = key(v)
    const list = idx.get(k)
    if (list) list.push(hit)
    else idx.set(k, [hit])
  }
  texts.forEach((t, source) => {
    for (const m of t.matchAll(NUM_IN_SOURCE)) {
      const v = Number(m[1].replace(/,/g, ""))
      const hit = { source, pos: m.index ?? 0 }
      add(v, hit)
      if (m[2]) add(v * (SCALE[m[2].toLowerCase()] ?? 1), hit)
    }
  })
  return idx
}

const LABELS = ["full board", "base camp", "basecamp", "per team", "per group", "per member", "local", "foreign", "nationals", "private"]
const norm = (s: string) => s.toLowerCase().replace(/[-‐‑–—_]/g, " ")

export function checkProvenance(md: string, opts: ProvenanceOptions): Finding[] {
  const rupee = opts.rupee ?? "PKR"
  const sources = opts.sources
  const texts = sources.map((s) => s.text)
  const normTexts = texts.map(norm)
  const idx = indexNumbers(texts)
  const earlierIdx = indexNumbers(opts.earlier ?? [])
  const out: Finding[] = []
  const calculated: string[] = []
  const repeated: string[] = []
  const links = citedLinks(md)

  for (const l of mdLines(md)) {
    if (l.code || !l.text.trim()) continue
    const t = plain(l.text)
    const amounts = parseAmounts(t, { rupee }).filter((a) => a.kind === "money")
    if (!amounts.length) continue
    const hasUsd = amounts.some((a) => a.cur === "USD")
    const lineCalc = CALCULATED.test(t) || TOTAL_LABEL.test(t.replace(/^\s*\|/, ""))
    const cited = links
      .filter((c) => c.line === l.index)
      .map((c) => normalizeUrl(c.url))
      .filter((u): u is string => !!u)
    const citedSources = new Set(sources.map((s, i) => (s.url && cited.includes(normalizeUrl(s.url) ?? "") ? i : -1)).filter((i) => i >= 0))

    for (const a of amounts) {
      const ends = a.range ? [a.lo, a.hi] : [a.lo]
      const hits = ends.map((v) => idx.get(key(v)) ?? [])
      const label = `${a.text.trim()}${a.plus ? "+" : ""}`
      if (hits.every((h) => h.length)) {
        // Found. Does the line's own link agree?
        if (citedSources.size && hits.some((h) => !h.some((x) => citedSources.has(x.source))))
          out.push({
            check: "provenance",
            severity: "hint",
            message: `${label} is in a page the agent read, but not in the page this line links to.`,
            evidence: { excerpt: l.text.trim(), line: l.index + 1, amount: label },
          })
        labelCheck(a, hits, l.text, l.index, label, normTexts, out)
        continue
      }
      const conversion = (a.cur === "PKR" || a.cur === "INR" || a.cur === "EUR" || a.cur === "GBP") && hasUsd
      if (lineCalc || a.approx || conversion) {
        calculated.push(label)
        continue
      }
      if (ends.every((v, i) => hits[i].length || earlierIdx.has(key(v)))) {
        repeated.push(label)
        continue
      }
      const missing = ends.filter((_, i) => !hits[i].length)
      out.push({
        check: "provenance",
        severity: "warn",
        message: `${label} is not in any page or tool output the agent read${a.range && missing.length === 1 ? ` (${fmtRange(missing[0], missing[0], a.cur)} isn't)` : ""}.`,
        evidence: { excerpt: l.text.trim(), line: l.index + 1, amount: label, missing },
      })
    }
  }
  if (calculated.length)
    out.push({
      check: "provenance",
      severity: "hint",
      message: `${calculated.length} amount${calculated.length === 1 ? " is" : "s are"} not in the sources but marked as calculated or converted: ${calculated.slice(0, 6).join(", ")}${calculated.length > 6 ? ", …" : ""}.`,
      evidence: { excerpt: calculated.join(" · "), amounts: calculated },
    })
  if (repeated.length)
    out.push({
      check: "provenance",
      severity: "hint",
      message: `${repeated.length} amount${repeated.length === 1 ? " repeats" : "s repeat"} an earlier message but ${repeated.length === 1 ? "is" : "are"} in no source: ${repeated.slice(0, 6).join(", ")}${repeated.length > 6 ? ", …" : ""}.`,
      evidence: { excerpt: repeated.join(" · "), amounts: repeated },
    })
  out.push(...checkClaims(md, normTexts))
  return out
}

function labelCheck(a: Amount, hits: Hit[][], line: string, lineIndex: number, label: string, normTexts: string[], out: Finding[]) {
  // The qualifier must sit next to the number in the answer (same table row, or within ~50 characters).
  const nl = norm(plain(line))
  const near = /^\s*\|/.test(line) ? nl : nl.slice(Math.max(0, a.start - 50), a.end + 50)
  for (const q of LABELS) {
    if (!new RegExp(`\\b${q}\\b`).test(near)) continue
    if (!normTexts.some((t) => t.includes(q))) continue
    // Is the phrase near this number anywhere it appears? (Both ends of a range must be.)
    const inSources = hits.every((h) => h.some((x) => normTexts[x.source].slice(Math.max(0, x.pos - 200), x.pos + 200).includes(q)))
    if (inSources) continue
    out.push({
      check: "label",
      severity: "hint",
      message: `${label} is called "${q}" here, but where the sources give ${a.range ? "these numbers" : "this number"}, "${q}" isn't nearby. Check the label.`,
      evidence: { excerpt: line.trim(), line: lineIndex + 1, amount: label, label: q },
    })
    return
  }
}

const STOP = new Set(["about", "their", "there", "these", "those", "which", "while", "would", "could", "should", "other", "being", "still", "every", "where", "after", "before"])

/** The claim's subject: the longer words in its sentence before the negation ("Permits are NOT discounted" → permit). */
function subjectStems(sentence: string): string[] {
  return (sentence.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6))
}

const CLAIM = /\b(?:not|no|never|isn['’]t|aren['’]t|doesn['’]t|don['’]t|without)\b[^.\n:]{0,40}?\b(discount\w*|waive\w*|exempt\w*|concession\w*|subsidi[sz]\w*|refund\w*|rebate\w*)/gi

function checkClaims(md: string, normTexts: string[]): Finding[] {
  const out: Finding[] = []
  for (const l of mdLines(md)) {
    if (l.code) continue
    const t = plain(l.text)
    for (const m of t.matchAll(CLAIM)) {
      const stem = m[1].toLowerCase().slice(0, 6)
      const at = m.index ?? 0
      const sentenceStart = Math.max(t.lastIndexOf(".", at - 1), t.lastIndexOf(":", at - 1), t.lastIndexOf(";", at - 1)) + 1
      const subjects = subjectStems(t.slice(sentenceStart, at))
      // Supported only if some line of some page uses the key word together with the claim's subject.
      const supported = normTexts.some((src) =>
        src.split(/\n/).some((line) => line.includes(stem) && (!subjects.length || subjects.some((w) => line.includes(w)))),
      )
      if (supported) continue
      out.push({
        check: "claim",
        severity: "hint",
        message: `"${m[0].trim()}" has no source: no line the agent read mentions ${subjects.length ? `"${subjects[0]}…" and ` : ""}"${m[1].toLowerCase()}" together. Say "Not confirmed:" or cite a page.`,
        evidence: { excerpt: l.text.trim(), line: l.index + 1, term: m[1] },
      })
    }
  }
  return out
}
