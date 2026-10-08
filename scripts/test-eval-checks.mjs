#!/usr/bin/env node
/**
 * Tier 0 of the answer-quality evals (docs/QUALITY.md Q0, docs/TESTING.md §1): the deterministic
 * answer checks in src/lib/answer-checks, on committed files only. No app, no network, no quota.
 *
 *   node scripts/test-eval-checks.mjs       # exit 0: every case passes; 1: the failures are listed
 *
 * 1. Unit cases: money parsing, every check, the transcript parser (the numbers prototype's 13
 *    self-tests, ported, plus the K2 shapes).
 * 2. Goldens: the real K2 export must FAIL with exactly the expected error classes, and its
 *    hand-corrected copy (only the wrong numbers in messages 14, 17 and 20 changed) must PASS.
 * 3. False alarms: every chat in the UI harness fixtures, exported through the real serializer
 *    (src/lib/transcript.ts) as Markdown and as JSON, must get no errors and no warnings.
 *
 * A new real failure that no check catches: write the check, then add the chat here as a golden.
 */
import { build } from "esbuild"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadChecks, ROOT } from "./eval/load-checks.mjs"

const started = Date.now()
const C = await loadChecks()
// The real serializer, to export the UI fixtures exactly as a share link would.
const serializer = await build({ entryPoints: [path.join(ROOT, "src", "lib", "transcript.ts")], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "warning" })
const T = await import(`data:text/javascript;base64,${Buffer.from(serializer.outputFiles[0].text).toString("base64")}`)

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}\n       ${err.message.split("\n").join("\n       ")}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
const errors = (fs) => fs.filter((f) => f.severity === "error")
const alarms = (fs) => fs.filter((f) => f.severity !== "hint")
const show = (fs) => fs.map((f) => `${f.severity} ${f.check}: ${f.message}`).join("\n") || "(none)"
const none = (fs, msg) => assert(!alarms(fs).length, `${msg}; got:\n${show(alarms(fs))}`)
const REF = C.REFERENCE_RATES
const answer = (md, ctx = {}) => C.checkAnswer(md, { referenceRates: REF, ...ctx })

// ---------------------------------------------------------------- 1a. the prototype's 13 self-tests, ported
// The prototype also had a calc tool; calc belongs to Q3 (syrup's MCP server), so its four tests
// become the same facts seen from the checks' side.
console.log("prototype self-tests (ported)")

check("calc → check: $15k–25k at 277 is 41.55–69.25 lakh, and that conversion passes", () => {
  const md = "At 1 USD = 277 PKR, $15,000 – $25,000 is PKR 41.55 lakh – 69.25 lakh."
  const a = C.parseAmounts(md, { rupee: "PKR" }).findLast((x) => x.cur === "PKR")
  eq([a.lo, a.hi], [4_155_000, 6_925_000], "PKR range")
  none(answer(md), "a correct conversion must pass")
})
check("calc → check: a range total is the sum of the lows and the sum of the highs", () => {
  const md = "Estimated costs:\n- Permit and royalty: $11k–17k\n- Agency package: $20k–40k\n- Gear: $5k–10k\n- Travel: $4k–7k\n\n**Total: $30k–65k**"
  const f = C.checkListTotals(md)
  eq(f[0]?.evidence.computed, { lo: 40_000, hi: 74_000 }, "computed parts")
})
check("calc → check: no rate known (none stated, no reference) means no currency verdict", () => {
  eq(C.checkCurrency("Fees: $5,000 (about PKR 4 crore).", { reference: {} }), [], "findings without any rate")
})
check("check: catches the 10x PKR slip against the stated rate", () => {
  const md = "| Item | USD | PKR |\n|---|---|---|\n| Permit | $15,000 | PKR 4.1 crore |\n| Liaison officer | $3,000 | PKR 83 lakh |\n| **Total** | **$18,000** | **PKR 4.93 crore** |\n\nRates: 1 USD = 277 PKR"
  const f = C.checkCurrency(md, { reference: REF })
  assert(f.some((x) => x.severity === "error" && x.evidence.statedRate === 277 && x.evidence.factor > 9), `expected a 10x error against 277, got:\n${show(f)}`)
})
check("check: that table's own total is consistent (4.1 crore + 83 lakh = 4.93 crore)", () => {
  const md = "| Item | USD | PKR |\n|---|---|---|\n| Permit | $15,000 | PKR 4.1 crore |\n| Liaison officer | $3,000 | PKR 83 lakh |\n| **Total** | **$18,000** | **PKR 4.93 crore** |"
  eq(C.checkTableTotals(md), [], "table-total findings")
})
check("check: catches the 10x slip with no stated rate (reference rate)", () => {
  const f = C.checkCurrency("| Item | USD | PKR |\n|---|---|---|\n| Permit | $15,000 | PKR 4.1 crore |", { reference: REF })
  assert(f.length === 1 && f[0].severity === "error" && f[0].evidence.statedRate === null, show(f))
})
check("check: a correct row passes", () => {
  eq(C.checkCurrency("| Item | USD | PKR |\n|---|---|---|\n| Permit | $15,000 | PKR 41.55 lakh |", { reference: REF }), [], "findings")
})
check("check: list total $30k–65k flagged, parts sum to $40k–74k", () => {
  const f = C.checkListTotals("Estimated costs:\n- Permit and royalty: $11k–17k\n- Agency package: $20k–40k\n- Gear: $5k–10k\n- Travel: $4k–7k\n\n**Total: $30k–65k**")
  assert(f.length === 1 && f[0].severity === "error", show(f))
})
check("check: a reconciled list passes", () => {
  eq(C.checkListTotals("Estimated costs:\n- Permit and royalty: $11k–17k\n- Agency package: $20k–40k\n- Gear: $5k–10k\n- Travel: $4k–7k\n\n**Total: $40k–74k**"), [], "findings")
})
check("check: table range total $15k–25k vs parts $21.5k–41k flagged", () => {
  const f = C.checkTableTotals("| Item | Cost |\n|---|---|\n| Flights | $1,500–3,000 |\n| Permit | $15,000–25,000 |\n| Gear | $5,000–13,000 |\n| **Total** | **$15,000–25,000** |")
  assert(f.length === 1 && f[0].severity === "error", show(f))
  eq(f[0].evidence.computed, { lo: 21_500, hi: 41_000 }, "computed")
})
check("parse: crore and Indian grouping", () => {
  eq(C.parseAmounts("4.1 crore PKR")[0].lo, 41_000_000, "4.1 crore")
  eq(C.parseAmounts("Rs 41,55,000")[0].lo, 4_155_000, "Rs 41,55,000")
})
check("parse: text is only read, never run (constructor, __proto__, process are just words)", () => {
  eq(C.parseAmounts("constructor __proto__ process toString"), [], "amounts")
  none(answer("| a | constructor |\n|---|---|\n| __proto__ | $1 |\n| Total | $1 |"), "hostile words")
})
check("parse: years and counts are not amounts", () => {
  eq(C.parseAmounts("In 1954 the team of 11 climbers reached 8,611 m; camps at 5,100–5,200 m on 2026-10-08."), [], "amounts")
})

// ---------------------------------------------------------------- 1b. money parsing
console.log("money parsing")

const lohi = (s, opts) => C.parseAmounts(s, opts).map((a) => [a.lo, a.hi, a.cur])
check("currencies: $ USD US$ PKR Rs ₨ INR ₹ € £", () => {
  eq(lohi("$5 · USD 6 · US$7 · PKR 8 · Rs 9 · ₨10 · INR 11 · ₹12 · €13 · £14 · 15 euros"), [[5, 5, "USD"], [6, 6, "USD"], [7, 7, "USD"], [8, 8, "PKR"], [9, 9, "PKR"], [10, 10, "PKR"], [11, 11, "INR"], [12, 12, "INR"], [13, 13, "EUR"], [14, 14, "GBP"], [15, 15, "EUR"]], "parsed")
})
check("scale words: k m mn bn thousand million billion lakh lac crore cr arab", () => {
  eq(lohi("$2k, $3m, $4mn, $5bn, $6 thousand, $7 million, $8 billion, 9 lakh, 10 lac, 11 crore, 12 Cr, 13 arab").map((x) => x[0]), [2e3, 3e6, 4e6, 5e9, 6e3, 7e6, 8e9, 9e5, 1e6, 11e7, 12e7, 13e9], "values")
})
check("Indian grouping: 41,50,000 and 4,15,00,000", () => {
  eq(lohi("₹41,50,000 and Rs 4,15,00,000"), [[4_150_000, 4_150_000, "INR"], [41_500_000, 41_500_000, "PKR"]], "parsed")
})
check("ranges: the first half inherits scale and currency", () => {
  eq(lohi("$40–74k"), [[40_000, 74_000, "USD"]], "$40–74k")
  eq(lohi("15k–25k"), [[15_000, 25_000, null]], "15k–25k (scaled, no currency)")
  eq(lohi("41.5–69.3 lakh"), [[4_150_000, 6_930_000, "PKR"]], "41.5–69.3 lakh")
  eq(lohi("PKR 4.1 Cr – 6.9 Cr"), [[41_000_000, 69_000_000, "PKR"]], "PKR 4.1 Cr – 6.9 Cr")
  eq(lohi("$500–2k"), [[500, 2000, "USD"]], "$500–2k: inheriting would invert the range")
  eq(lohi("from $8,500 to $15,000"), [[8500, 15_000, "USD"]], "to")
})
check('"between X and Y" is a range; "X and Y" alone is two amounts', () => {
  eq(lohi("between $30,000 and $65,000+ USD"), [[30_000, 65_000, "USD"]], "between")
  eq(lohi("$5,000 and $8,000"), [[5000, 5000, "USD"], [8000, 8000, "USD"]], "two amounts")
})
check('"L" alone is not lakh; "m" without a currency is metres', () => {
  eq(lohi("55 L – 1.1 Cr"), [[11_000_000, 11_000_000, "PKR"]], "only 1.1 Cr parses")
  eq(C.parseAmounts("8,000 m and 5–8 m"), [], "metres")
  eq(lohi("$5 m budget"), [[5e6, 5e6, "USD"]], "with a currency, m is million")
})
check("approx and plus markers", () => {
  const [a, b] = C.parseAmounts("~$5,000 and about $65,000+")
  assert(a.approx && !a.plus && b.approx && b.plus, JSON.stringify([a, b]))
})
check("rupee: INR when the text is about India", () => {
  eq(C.inferRupee("A trek in India costs Rs 50,000."), "INR", "India")
  eq(C.inferRupee("K2 for a Pakistani, in PKR"), "PKR", "Pakistan")
})
check("stated rates in their common shapes", () => {
  eq(C.statedRates("1 USD = 277 PKR"), { PKR: 277 }, "1 USD = 277 PKR")
  eq(C.statedRates("At the current exchange rate of **~277 PKR per 1 USD**"), { PKR: 277 }, "~277 PKR per 1 USD")
  eq(C.statedRates("$1 ≈ Rs 280.5"), { PKR: 280.5 }, "$1 ≈ Rs 280.5")
  eq(C.statedRates("USD/INR 88"), { INR: 88 }, "USD/INR 88")
})

// ---------------------------------------------------------------- 1c. the checks, on the K2 shapes
console.log("checks")

check('K2: "4.1 Cr – 6.9 Cr" for $15k–25k is flagged (no rate stated: reference)', () => {
  const f = answer("Your budget: **PKR 4.1 Cr – 6.9 Cr** ($15,000 – $25,000).")
  assert(errors(f).some((x) => x.check === "currency"), show(f))
})
check('K2: "$30,000 and $65,000+" stated before parts that add to $40k–74k is flagged', () => {
  const md = "A fully supported K2 expedition generally costs between **$30,000 and $65,000+ USD** all-in per person.\n\nA typical cost breakdown:\n\n* **Operator Package (Full-Board):** **$28,000 – $45,000 USD**\n  * Base-camp-only packages are cheaper, around $12,000–$15,000.\n* **Government Permits:** **$3,000 – $6,000 USD**\n* **Insurance:** **$2,000 – $4,000 USD**\n* **Personal Climbing Gear:** **$5,000 – $15,000 USD**\n* **Flights & Visas:** **$2,000 – $4,000 USD**"
  const f = C.checkListTotals(md)
  assert(f.length === 1 && f[0].severity === "error", show(f))
  eq(f[0].evidence.computed, { lo: 40_000, hi: 74_000 }, "parts (the nested bullet is a detail, not a part)")
})
check("K2: a total row $15k–25k over rows adding to $21.5k–41k is flagged", () => {
  const md = "| Cost Component | USD Range |\n| :--- | :--- |\n| Operator | $8,500 – $15,000 |\n| Permits | ~$5,000 |\n| Gear | $5,000 – $15,000 |\n| Insurance | $2,000 – $4,000 |\n| Travel | $1,000 – $2,000 |\n| **TOTAL ESTIMATE** | **$15,000 – $25,000+** |"
  const f = C.checkTableTotals(md)
  assert(f.length === 1 && f[0].severity === "error", show(f))
})
check('K2: the correct "41.5–69.3 lakh" passes', () => {
  none(answer("At ~277 PKR per USD, $15,000–25,000 is about **PKR 41.5–69.3 lakh**."), "correct lakh range")
  none(answer("Budget: PKR 41.5–69.3 lakh ($15,000–25,000)."), "correct, with no rate stated")
})
check("K2: a correct table passes (USD and PKR columns, totals, rate stated)", () => {
  const md = "At **~277 PKR per 1 USD**:\n\n| Cost Component | USD Range | PKR Range (approx.) |\n| :--- | :--- | :--- |\n| Operator | $8,500 – $15,000 | **23.5 lakh – 41.6 lakh** |\n| Permits | ~$5,000 | **~13.9 lakh** |\n| Gear | $5,000 – $15,000 | **13.9 lakh – 41.6 lakh** |\n| Insurance | $2,000 – $4,000 | **5.5 lakh – 11.1 lakh** |\n| Travel | $1,000 – $2,000 | **2.8 lakh – 5.5 lakh** |\n| **TOTAL ESTIMATE** | **$21,500 – $41,000+** | **PKR 59.6 lakh – 1.14 Cr+** |"
  none(answer(md), "correct table")
})
check("currency: a small miss against the stated rate is a warning, not an error", () => {
  const f = answer("1 USD = 277 PKR. The permit is $1,000 (PKR 300,000).")
  eq(f.map((x) => `${x.check}:${x.severity}`), ["currency:warn"], "findings")
})
check("currency: rounding the shown digits allow is not a miss", () => {
  none(answer("1 USD = 277 PKR. The permit is $15,000 (about PKR 42 lakh), gear $2,000 (PKR 5.5 lakh)."), "rounded conversions")
})
check("currency: unrelated amounts in two currencies on one line are not a pair", () => {
  none(answer("The permit costs $5,000, while a porter in Skardu earns about PKR 3,000 a day."), "not a conversion")
})
check("currency: the 10x slip written as a plain sentence is caught", () => {
  for (const md of [
    "$15,000 is about PKR 4.1 crore at 277 PKR per USD.",
    "$15,000 is about PKR 4.1 crore.",
    "$15,000 is about Rs 4.1 crore.",
    "The budget is $15,000, which is about 4.1 crore rupees.",
    "That comes to roughly 4.1 crore PKR for a $15,000 budget.",
    "At 1 USD = 277 PKR, $15,000 comes to PKR 4.1 crore.",
  ])
    assert(errors(answer(md)).some((f) => f.check === "currency"), `missed: ${md}`)
})
check("currency: sentence pairing leaves rates, other periods and separate sentences alone", () => {
  for (const md of [
    "$15,000 converts to 41.5 lakh PKR.",
    "At 277 PKR per USD, $15,000 is about PKR 41.5 lakh.",
    "The plan is $20 per month, or ₹20,000 per year in India.",
    "Option A costs $500 per month; option B costs €450 per month.",
    "Rs 277 per dollar is today's rate, and the gear costs $5,000.",
    "The permit is $5,000. The insurance is PKR 5.5 lakh.",
    "K2 is 8,611 m high and costs about $40,000 to climb.",
    "Revenue was $1.2M in 2025, about 33 crore rupees.",
  ])
    none(answer(md), md)
})
check("currency: EUR and GBP against USD use the reference too", () => {
  assert(errors(answer("The fee is $1,000 (about €8,600).")).length === 1, "10x EUR slip")
  none(answer("The fee is $1,000 (about €860)."), "correct EUR")
})
check("lists: alternatives that span the total are not summed", () => {
  none(answer("Budget tiers:\n- Basic: $30k\n- Standard: $45k\n- Luxury: $65k\n\nAll-in costs run $30k–65k."), "tiers")
})
check("lists: prices per day are not summed into a trip total", () => {
  none(answer("- Porter: $25 per day\n- Cook: $30 per day\n\nTotal: $3,300 for the 60-day trip."), "per-day items")
})
check("lists: with unpriced items, only parts that already exceed the total are flagged", () => {
  none(answer("Total: $10,000 all-in.\n\n- Permit: $5,000\n- Guide: $3,000\n- Food and fuel (varies)"), "unpriced item, parts below total")
  assert(errors(answer("Total: $6,000 all-in.\n\n- Permit: $5,000\n- Guide: $3,000\n- Food and fuel (varies)")).length === 1, "parts above the total")
})
check("lists: a prose total far from the parts is about something else", () => {
  none(answer("Most expeditions cost $40,000 in total. Ways to save:\n\n- Rent gear: $1,000\n- Share a cook: $500"), "savings list")
})
check("lists: a prose total over a partial list only fails when the parts exceed it", () => {
  none(answer("The total market is $50B. Key segments:\n\n- Cloud: $20B\n- Devices: $15B"), "some segments")
  assert(errors(answer("The total market is $30B. Key segments:\n\n- Cloud: $20B\n- Devices: $15B")).length === 1, "segments above the total")
  assert(errors(answer("The total market is $50B. The breakdown:\n\n- Cloud: $20B\n- Devices: $15B")).length === 1, "called a breakdown, so it must add up")
})
check('ranges: "$20 – ₹1,660" is two amounts, not a range', () => {
  eq(lohi("$20 – ₹1,660"), [[20, 20, "USD"], [1660, 1660, "INR"]], "parsed")
})
check("tables: Subtotal rows are skipped; Included is zero; optional rows may be left out", () => {
  none(answer("| Item | Cost |\n|---|---|\n| Permit | $5,000 |\n| Guide | $3,000 |\n| Subtotal | $8,000 |\n| Meals | Included |\n| Oxygen (optional) | $4,000 |\n| **Total** | **$8,000** |"), "subtotal, included, optional")
})
check("tables: a column with a cell that isn't one amount is not summed", () => {
  none(answer("| Item | Cost |\n|---|---|\n| Permit | $5,000 per person, $9,500 per team |\n| Guide | $3,000 |\n| **Total** | **$8,000** |"), "two amounts in a cell")
  none(answer("| Item | PKR |\n|---|---|\n| Insurance | 55 L – 1.1 Cr |\n| Travel | 28 L |\n| **Total** | **2 Cr** |"), '"L" cells are not read')
})
check("tables: a header currency makes bare numbers amounts", () => {
  const f = C.checkTableTotals("| Item | Cost (USD) |\n|---|---|\n| Permit | 5,000 |\n| Guide | 3,000 |\n| **Total** | **9,000** |")
  assert(f.length === 1 && f[0].severity === "error", show(f))
})

const web = (url, text) => ({ kind: "webfetch", url, text })
check("provenance: found, found only in another source, not found, calculated, earlier", () => {
  const sources = [web("https://a.example.org/k2", "Full board K2 package: USD 28,000 per person."), web("https://b.example.org/permits", "Royalty is $9,500 per team.")]
  eq(alarms(C.checkProvenance("The full board package is $28,000.", { sources })), [], "found")
  const other = C.checkProvenance("Royalty: $9,500 ([source](https://a.example.org/k2)).", { sources })
  assert(other.some((f) => f.check === "provenance" && f.severity === "hint" && /not in the page this line links to/.test(f.message)), show(other))
  const missing = C.checkProvenance("Insurance is $4,200.", { sources })
  eq(missing.map((f) => `${f.check}:${f.severity}`), ["provenance:warn"], "not found")
  const calc = C.checkProvenance("In total about $37,500.", { sources })
  eq(calc.map((f) => `${f.check}:${f.severity}`), ["provenance:hint"], "calculated")
  const earlier = C.checkProvenance("Insurance is still $4,200.", { sources, earlier: ["Insurance is $4,200."] })
  eq(earlier.map((f) => `${f.check}:${f.severity}`), ["provenance:hint"], "repeated from an earlier answer")
})
check("provenance and links are only checked when the agent read the web", () => {
  none(C.checkAnswer("Insurance is $4,200. See https://nowhere.example.net/x", { sources: [{ kind: "read", text: "const x = 1" }] }), "coding chat")
})
check("label: a number called full board where the sources say otherwise is a hint", () => {
  const filler = " Our team handles permits, porters, cooks and the walk in from Askole.".repeat(4)
  const sources = [web("https://a.example.org/k2", `Full board expedition: $28,000.${filler} Base camp services only: $8,500.`)]
  const f = C.checkProvenance("| Local Operator Package (Full-Board) | $8,500 |", { sources })
  assert(f.some((x) => x.check === "label" && x.severity === "hint"), show(f))
})
check("claim: a blanket 'not discounted' with no line saying so is a hint", () => {
  const sources = [web("https://a.example.org/k2", "Group discount prices for private treks.\nPermit fee is $5,000.")]
  const f = C.checkProvenance("Permits are NOT discounted for locals.", { sources })
  assert(f.some((x) => x.check === "claim" && x.severity === "hint"), show(f))
  const ok = C.checkProvenance("Permits are not discounted.", { sources: [web("https://a.example.org/k2", "No discount on permit fees for nationals.")] })
  assert(!ok.some((x) => x.check === "claim"), show(ok))
})
check("cited URLs: normalised match passes; unseen host warns; seen host hints", () => {
  const sources = [{ kind: "websearch", url: "https://www.apricottours.pk/tours/k2-expedition/", text: "Title: K2\nURL: https://www.apricottours.pk/tours/k2-expedition/" }]
  eq(C.checkCitedUrls("[Apricot](http://apricottours.pk/tours/k2-expedition?utm_source=x#price)", sources), [], "normalised")
  eq(C.checkCitedUrls("See https://apricottours.pk/tours/other.", sources).map((f) => f.severity), ["hint"], "same site, other page")
  eq(C.checkCitedUrls("See [this](https://invented.example.net/k2-prices).", sources).map((f) => f.severity), ["warn"], "invented")
  eq(C.checkCitedUrls("Run `curl https://invented.example.net` or open http://localhost:3000", sources), [], "code and localhost")
})

// ---------------------------------------------------------------- 1d. transcript parser
console.log("transcript parser")

const k2 = readFileSync(path.join(ROOT, "scripts", "fixtures", "eval", "transcripts", "k2.md"), "utf8")
const k2fixed = readFileSync(path.join(ROOT, "scripts", "fixtures", "eval", "transcripts", "k2-fixed.md"), "utf8")
const K2 = C.parseTranscript(k2)

check("markdown: messages, roles, turns and title", () => {
  eq(K2.form, "markdown", "form")
  eq(K2.title, "Greeting", "title")
  eq(K2.messages.length, 20, "messages")
  eq(K2.messages.filter((m) => m.role === "user").length, 7, "user messages")
  eq(K2.turns.length, 7, "turns")
  eq(K2.messages.map((m) => m.index), [...Array(20).keys()].map((i) => i + 1), "indexes")
  eq(K2.models, ["Gemini 3.5 Flash Lite (Google)", "Nemotron 3 Ultra 550B A55b (OpenRouter)"], "models")
})
check("markdown: tool calls with inputs and outputs (6, as the header says)", () => {
  const tools = K2.messages.flatMap((m) => m.tools)
  eq(tools.length, 6, "tool calls")
  eq(tools[0].tool, "websearch", "tool")
  eq(tools[0].input, { query: "top 10 highest mountains in the world latest studies measurement" }, "input")
  assert(tools[0].output.startsWith("Title: List of highest mountains on Earth"), "output start")
  // Outputs contain "## " headings and pipes; none of it may leak into answers.
  assert(!K2.messages.some((m) => /^URL: https?:/m.test(m.text)), "tool output leaked into an answer")
})
check("markdown: per-message metadata (took, TTFT, tokens, model, router note, thinking)", () => {
  const m20 = K2.messages[19]
  eq(m20.label, "Auto → Nemotron 3 Ultra 550B A55b (OpenRouter)", "label")
  eq([m20.meta.tookMs, m20.meta.ttftMs, m20.meta.tokens, m20.meta.cost, m20.meta.agent, m20.meta.finish], [60_000, 4500, 65_000, 0, "build", "stop"], "meta")
  assert(/answered after 3 tries/.test(m20.meta.router ?? ""), "router note")
  assert(m20.reasoning.startsWith("The current exchange rate is around 277 PKR"), "thinking")
  assert(m20.text.startsWith("At the current exchange rate") && m20.text.endsWith("pay premiums in USD."), "answer text, footer stripped")
  eq(K2.messages[1].meta.ttftMs, 908, "908ms")
})
check("markdown: lookalike headings, fences and tool headings inside an answer stay text", () => {
  const md = "# Chat\n\n> Shared from syrup · snapshot 2026-10-08 10:27:16 UTC\n> Format: syrup.transcript v1\n\n---\n\n## 1. User · 2026-10-08 10:23:05 UTC\n\nhi\n\n## 2. Assistant · Auto · 2026-10-08 10:23:05 UTC\n\n_took 1.7s · 908ms to first token · 6.9k tokens · $0 · agent build · finish stop_\n\nSee:\n\n```md\n### Tool: bash · completed\n## 3. User · 2026-10-08 10:23:05 UTC\n```\n\n## 9. User · 2026-10-08 10:23:05 UTC\n\nDone.\n\n---\n\n_Shared from syrup, a free-first coding agent. This is a snapshot: messages sent after it stay private._\n"
  const t = C.parseTranscript(md)
  eq(t.messages.length, 2, "messages")
  assert(t.messages[1].text.includes("### Tool: bash") && t.messages[1].text.includes("## 9. User") && t.messages[1].text.endsWith("Done."), t.messages[1].text)
  eq(t.messages[1].tools.length, 0, "tools")
})
check("json: the share/CLI JSON and its --debug wrapper parse the same", () => {
  const json = { format: "syrup.transcript", version: 1, title: "t", models: ["m"], messages: [
    { id: "1", role: "user", createdAt: 1, parts: [{ type: "text", id: "a", text: "how much?" }, { type: "text", id: "b", text: "file body", synthetic: true }] },
    { id: "2", role: "assistant", createdAt: 10, completedAt: 2010, modelLabel: "Auto → X", tokens: { input: 900, output: 50, reasoning: 0, cacheRead: 100, cacheWrite: 0 }, routed: [{ ttftMs: 700 }], finish: "stop", parts: [
      { type: "tool", id: "c", tool: "webfetch", status: "completed", input: { url: "https://a.example.org" }, output: "Price: $5,000" },
      { type: "text", id: "d", text: "It costs $5,000." }] }] }
  const a = C.parseTranscript(JSON.stringify(json))
  const b = C.parseTranscript(JSON.stringify({ format: "syrup.debug", version: 1, transcript: json }))
  eq(a, b, "debug wrapper")
  eq([a.form, a.messages[0].context, a.messages[1].meta.tookMs, a.messages[1].meta.ttftMs, a.messages[1].meta.inputTokens, a.messages[1].tools[0].output], ["json", ["file body"], 2000, 700, 1000, "Price: $5,000"], "fields")
})

// ---------------------------------------------------------------- 2. goldens
console.log("goldens")

const k2Report = C.checkTranscript(K2, { referenceRates: REF })
const errorClasses = (r) => [...new Set(r.reports.flatMap((m) => m.findings.filter((f) => f.severity === "error").map((f) => `${f.check}@${m.index}`)))].sort()
check("k2.md FAILS with exactly: 10x currency on 20, totals on 14 and 20", () => {
  eq(errorClasses(k2Report), ["currency@20", "list-total@14", "table-total@20"], "error classes")
})
check("k2.md: the relabelled range and the unsupported claim show as hints (what code can see of them)", () => {
  const hints = k2Report.reports.flatMap((m) => m.findings.filter((f) => f.severity === "hint").map((f) => `${f.check}@${m.index}`))
  for (const h of ["label@17", "label@20", "claim@20"]) assert(hints.includes(h), `missing ${h} in ${hints.join(", ")}`)
})
check("k2.md: its correct answers (2, 5, 8, 11: peaks, guide, gear) get no findings at all", () => {
  const flagged = k2Report.reports.map((r) => r.index).filter((i) => [2, 5, 8, 11].includes(i))
  eq(flagged, [], "flagged correct answers")
})
check("k2.md: the 65k-token last turn is over the context budget (warning)", () => {
  assert(k2Report.reports.find((r) => r.index === 20)?.findings.some((f) => f.check === "context" && f.severity === "warn"), "context warning on 20")
})
check("k2-fixed.md PASSES with zero errors", () => {
  const r = C.checkTranscript(C.parseTranscript(k2fixed), { referenceRates: REF })
  eq(r.counts.error, 0, `errors:\n${show(r.reports.flatMap((m) => m.findings))}`)
})
check("k2-fixed.md differs from k2.md only in the answers of messages 14, 17 and 20", () => {
  const a = k2.split(/\r?\n/)
  const b = k2fixed.split(/\r?\n/)
  eq(a.length, b.length, "line count")
  const f = C.parseTranscript(k2fixed)
  const changed = K2.messages.filter((m, i) => m.text !== f.messages[i].text).map((m) => m.index)
  eq(changed, [14, 17, 20], "changed answers")
  assert(K2.messages.every((m, i) => m.reasoning === f.messages[i].reasoning && JSON.stringify(m.tools) === JSON.stringify(f.messages[i].tools)), "tools or thinking changed")
  const diffLines = a.filter((l, i) => l !== b[i]).length
  assert(diffLines === 10, `expected 10 changed lines, got ${diffLines}`)
})

// ---------------------------------------------------------------- 3. false alarms on correct answers
console.log("false alarms (UI harness fixtures, exported through src/lib/transcript.ts)")

const uiDir = path.join(ROOT, "scripts", "fixtures", "ui")
const chats = new Map()
for (const file of readdirSync(uiDir).filter((f) => f.endsWith(".mjs") && !f.startsWith("_")).sort()) {
  const mod = await import(pathToFileURL(path.join(uiDir, file)).href)
  for (const s of [mod.default].flat()) {
    const e = s.engine
    for (const session of e.sessions) {
      const messages = e.messages[session.id]
      if (!messages?.length || chats.has(session.id)) continue
      chats.set(session.id, { title: session.title, messages, answers: e.answers?.[session.id] ?? [] })
    }
  }
}
let answers = 0
check(`every fixture chat, Markdown and JSON, gets no errors or warnings (${chats.size} chats)`, () => {
  const bad = []
  for (const [id, c] of chats) {
    const t = T.buildTranscript({ title: c.title, messages: c.messages, answers: c.answers, snapshotAt: 0 })
    for (const [form, text] of [["md", T.renderMarkdown(t)], ["json", T.renderJSON(t)]]) {
      const parsed = C.parseTranscript(text)
      if (form === "md") answers += parsed.messages.filter((m) => m.role === "assistant" && m.text).length
      const r = C.checkTranscript(parsed, { referenceRates: REF })
      for (const m of r.reports) for (const f of m.findings) if (f.severity !== "hint") bad.push(`${c.title} (${id}, ${form}) #${m.index}: ${f.severity} ${f.check}: ${f.message}`)
    }
  }
  assert(!bad.length, bad.join("\n"))
})
check("fixture chats parse the same from Markdown and from JSON", () => {
  for (const [, c] of chats) {
    const t = T.buildTranscript({ title: c.title, messages: c.messages, answers: c.answers, snapshotAt: 0 })
    const md = C.parseTranscript(T.renderMarkdown(t))
    const js = C.parseTranscript(T.renderJSON(t))
    // renderMarkdown drops a tool output's trailing newline and squeezes 3+ newlines to 2 everywhere; the rest must match.
    const end = (v) => (v === undefined ? null : v.replace(/\n$/, "").replace(/\n{3,}/g, "\n\n"))
    const shape = (p) => p.messages.map((m) => [m.index, m.role, m.text.trim(), m.tools.map((x) => [x.tool, x.status, end(x.output), end(x.error)]), m.reasoning.trim()])
    eq(shape(md), shape(js), `"${c.title}"`)
    // The owner's debug export puts the router timeline and logs (with their own headings and fences) first.
    const debug = T.buildDebug({ sessionId: "ses_test", transcript: t, events: [], logs: [{ ts: 0, level: "info", source: "test", event: "## 1. User · 2026-10-08 10:23:05 UTC", data: null }], generatedAt: 0 })
    eq(shape(C.parseTranscript(T.renderDebugMarkdown(debug))), shape(js), `"${c.title}" (debug Markdown)`)
    eq(shape(C.parseTranscript(T.renderJSON(debug))), shape(js), `"${c.title}" (debug JSON)`)
  }
})

const ms = Date.now() - started
console.log(`\n${passed} passed, ${failed} failed · ${chats.size} fixture chats, ${answers} answers checked for false alarms · ${(ms / 1000).toFixed(1)}s`)
process.exit(failed ? 1 : 0)
