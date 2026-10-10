/**
 * The four grounding errors of the K2 incident (docs/QUALITY.md §1 and Q4; the grounding report §6.1), as eval checks
 * on the live answer. Each is deliberately narrow: it fails on the error's shape, not on a wording it doesn't know.
 *
 *   (a) merged range   a range sold as one operator's or Pakistanis' rate whose two ends no single page gives
 *   (b) wrong label    a base-camp-sized price (under $20,000) called "full board"
 *   (c) unsourced      "permits are not discounted / apply equally to Pakistanis" stated as fact
 *   (d) silent pick    one permit scheme ($5,000 per person or $9,500 per team) given without the other and no
 *                      "Sources differ"
 */
import { checks as c } from "./kit.mjs"

const answerOf = (t) =>
  t.live
    .filter((m) => m.role === "assistant")
    .map((m) => m.text)
    .join("\n")
/** Every tool output the agent had read in the chat by the live turn (seeded turns included). */
const pagesOf = (t) => (t.parsed?.messages ?? []).flatMap((m) => (m.tools ?? []).filter((x) => /web|search|fetch/i.test(x.tool)).map((x) => String(x.output ?? "")))
const lines = (s) => s.split("\n").filter((l) => l.trim())
const has = (page, v) => new RegExp(`(?<![\\d,.])${String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",?")}(?![\\d]|,\\d)`).test(page)

const ESTIMATE = /\b(total|estimat\w*|budget|all[- ]in|approx\w*|about|around|roughly|typically|overall|compared)\b|~|≈/i

export const k2a = c.custom({
  name: "k2-a merged",
  column: "a",
  run: (t) => {
    const text = answerOf(t)
    if (/8,?500\s*(?:–|-|—|to)\s*\$?\s*15,?000/i.test(text)) return { pass: false, detail: "$8,500–15,000 again" }
    const pages = pagesOf(t)
    for (const line of lines(text)) {
      if (!/(local|pakistani|national|citizen)/i.test(line) || !/(rate|price|package|operator|cost)/i.test(line)) continue
      // A total or an estimate is worked out, not quoted: the error is a quoted range whose ends came from two places.
      if (ESTIMATE.test(line)) continue
      for (const a of t.parseAmounts(line).filter((x) => x.kind === "money" && x.cur === "USD" && x.range)) {
        if (!pages.some((p) => has(p, a.lo) && has(p, a.hi)))
          return {
            pass: false,
            detail: `"${a.text.trim()}" on a local-rate line: no page gives both ends`,
          }
      }
    }
    return { pass: true, detail: "no merged range" }
  },
})

export const k2b = c.custom({
  name: "k2-b label",
  column: "b",
  run: (t) => {
    for (const line of lines(answerOf(t))) {
      for (const a of t.parseAmounts(line).filter((x) => x.kind === "money" && x.cur === "USD" && x.hi < 20_000 && x.hi >= 3_000)) {
        const near = line.slice(Math.max(0, a.start - 60), a.end + 60)
        if (/full[- ]?board/i.test(near) && !/base[- ]?camp/i.test(near))
          return {
            pass: false,
            detail: `"${a.text.trim()}" called full board: ${line.trim().slice(0, 140)}`,
          }
      }
    }
    return { pass: true, detail: "no base-camp price called full board" }
  },
})

const SAME =
  /\b(?:not|no|n['’]t)\s+(?:be\s+|get\s+|receive\s+)?(?:any\s+)?(?:discount|reduc|waiv|exempt|lower|cheaper)|appl(?:y|ies)\s+(?:equally|the same|as well|in full|to (?:all|local|pakistani))|same\s+(?:rate|fee|permit|royalt|price)|also\s+(?:apply|pay)|still\s+(?:apply|pay)|regardless of (?:nationality|citizenship)|\bequally\b/i

/**
 * The other direction of the same error: Pakistanis' permits subsidised, waived, exempt or cheaper. No page the agent
 * can read states a rule either way, so any such line is unsourced unless it is marked "Not confirmed" or hedged.
 */
const RULE = /\b(discount\w*|subsidi[sz]\w*|waive\w*|exempt\w*|concession\w*|cheaper|nominal|reduced)\b/i
const HEDGED = /not confirmed|(couldn['’]t|could not|can['’]t|cannot)\s+(find|confirm|verify)|\b(no|none of the) (page|source)s?\b|not (stated|mentioned|listed|specified)|(don['’]t|do not|doesn['’]t|does not|didn['’]t|did not)\s+(say|state|mention|list)/i

export const k2c = c.custom({
  name: "k2-c unsourced",
  column: "c",
  run: (t) => {
    for (const line of lines(answerOf(t))) {
      if (HEDGED.test(line)) continue
      if (!/(pakistani|local|national|citizen|domestic)/i.test(line)) continue
      // The claim must be about the permit itself: its words within 80 characters of "permit" or "royalty".
      const near = [...line.matchAll(/permit|royalt/gi)].map((m) => line.slice(Math.max(0, m.index - 80), m.index + 80))
      if (near.some((w) => SAME.test(w) || RULE.test(w))) return { pass: false, detail: line.trim().slice(0, 160) }
    }
    return { pass: true, detail: "no unsourced permit claim" }
  },
})

export const k2d = c.custom({
  name: "k2-d differ",
  column: "d",
  run: (t) => {
    const text = answerOf(t)
    if (/sources differ/i.test(text)) return { pass: true, detail: '"Sources differ"' }
    const permit = lines(text).filter((l) => /(permit|royalt)/i.test(l))
    const vals = permit.flatMap((l) =>
      t
        .parseAmounts(l)
        .filter((a) => a.kind === "money" && a.cur === "USD")
        .flatMap((a) => [a.lo, a.hi]),
    )
    const person = vals.includes(5_000)
    const team = vals.includes(9_500)
    if (person === team)
      return {
        pass: true,
        detail: person ? "both schemes" : "no permit figure",
      }
    return {
      pass: false,
      detail: `only the ${person ? "$5,000 per person" : "$9,500 per team"} scheme, no "Sources differ"`,
    }
  },
})

/** All four at once: what "the K2 grounding errors are fixed" means for one trial. */
export const K2_GROUNDING = [k2a, k2b, k2c, k2d]
