#!/usr/bin/env node
/**
 * Tests the chat's source matcher (src/lib/grounding.ts, docs/QUALITY.md Q4) and measures its soft flag.
 * No network, no browser. Under two seconds.
 *
 *   pnpm test:grounding            unit tests, then precision on every labelled set
 *   pnpm test:grounding --dump DIR  print the flags in eval transcripts under DIR (node_modules/.cache/syrup-eval/…)
 *                                   with the cited page around each, for labelling a new set
 *
 * The flag (a money amount on a line that links a page, not found in that page) ships on only at ≥ 95% precision on a
 * BLIND set: labelled before anyone tunes the matcher on it (the Q3 rule). Labelled sets live in
 * scripts/fixtures/grounding/*.json: { set, blind, source, items: [{ id, answer, turn, session, labels: { amount: "right" |
 * "wrong" } }] }. "right": the cited page really doesn't state that amount, in any notation. Labels are read from the
 * page, never from the matcher. Every flag the matcher raises must have a label, so a changed matcher can't hide in
 * unlabelled flags. Sets come from eval transcripts and hand-written cases, never from anyone's stored chats.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT = path.join(ROOT, "node_modules", ".cache", "syrup-grounding-test")
fs.mkdirSync(OUT, { recursive: true })
const outfile = path.join(OUT, "grounding.mjs")
await build({ entryPoints: [path.join(ROOT, "src", "lib", "grounding.ts")], outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" })
const G = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)

/** A transcript's tool part (syrup.transcript v1) as the chat's WebPart. */
const asPart = (p) => ({ tool: p.tool, state: { status: p.status, input: p.input, output: p.output } })
const flagsOf = (g) => Object.values(g.chips).flatMap((c) => c.flags.map((f) => ({ amount: f, page: c.page })))

// ---------------------------------------------------------------- --dump: prepare a set for labelling

if (process.argv.includes("--dump")) {
  const dir = process.argv[process.argv.indexOf("--dump") + 1]
  const items = []
  for (const run of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())) {
    for (const f of fs.readdirSync(path.join(dir, run)).filter((f) => /-\d+\.json$/.test(f) && !f.includes("seed"))) {
      let t
      try {
        t = JSON.parse(fs.readFileSync(path.join(dir, run, f), "utf8"))
      } catch {
        continue
      }
      if (t.format !== "syrup.transcript") continue
      let session = []
      let turn = []
      for (const m of t.messages ?? []) {
        if (m.role === "user") {
          turn = []
          continue
        }
        const web = (m.parts ?? []).filter((p) => p.type === "tool" && /^(webfetch|websearch)$/.test(p.tool) && p.status === "completed").map(asPart)
        turn = [...turn, ...web]
        session = [...session, ...web]
        const answer = (m.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n\n")
        if (!answer.trim() || !session.length) continue
        const g = G.ground(answer, G.pagesFrom(turn), G.pagesFrom(session))
        if (!Object.keys(g.chips).length) continue
        items.push({ id: `${run}/${f}#${m.id}`, answer, turn, session, labels: Object.fromEntries(flagsOf(g).map((x) => [x.amount, "?"])) })
        for (const x of flagsOf(g)) {
          const digits = x.amount.replace(/[^\d.]/g, "").replace(/\.0+$/, "")
          const i = x.page.text.replace(/,/g, "").indexOf(digits.slice(0, 3))
          console.log(
            `\n## ${run}/${f} · ${x.amount} · ${x.page.url}\n  page near "${digits.slice(0, 3)}": ${i < 0 ? "(no such digits)" : JSON.stringify(x.page.text.replace(/,/g, "").slice(Math.max(0, i - 80), i + 80))}`,
          )
        }
      }
    }
  }
  const file = path.join(OUT, "dump.json")
  fs.writeFileSync(file, JSON.stringify({ items }, null, 1))
  console.log(`\n${items.length} answers with chips, ${items.reduce((n, i) => n + Object.keys(i.labels).length, 0)} flags → ${file}`)
  process.exit(0)
}

// ---------------------------------------------------------------- unit tests

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}: ${err?.message ?? err}`)
  }
}
function eq(a, b, msg) {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg}: expected ${y}, got ${x}`)
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}

const fetchPart = (url, title, body, fetched = "2026-10-10") => ({
  tool: "webfetch",
  state: { status: "completed", input: { url }, output: `Source: ${url}\nTitle: ${title}\nFetched: ${fetched}\n---\n\n${body}` },
})
const searchPart = (results) => ({
  tool: "websearch",
  state: { status: "completed", input: { query: "q" }, output: results.map((r) => `Title: ${r.title}\nURL: ${r.url}\nPublished: N/A\nHighlights:\n${r.text}`).join("\n\n---\n\n") },
})

const TOURS = fetchPart(
  "https://tours.example.com/k2/",
  "K2 Expedition 2026",
  "| Group size | Base camp service | Full board |\n| --- | --- | --- |\n| 1-2 members | $15,000 | $30,000 |\n| 6+ members | $8,500 | $28,000 |",
)
const PERMIT = searchPart([{ title: "Royalty 2026", url: "https://gb.example.org/royalty?utm_source=x", text: "Royalty per person for K2: USD 5,000 in summer." }])

test("pages: a fetched page by its Source header, search results by their URL lines; once each", () => {
  const pages = G.pagesFrom([TOURS, PERMIT, fetchPart("https://gb.example.org/royalty", "Royalty schedule", "Summer USD 5,000; team USD 9,500.")])
  eq(
    pages.map((p) => [p.id, p.via, p.title, p.host]),
    [
      ["tours.example.com/k2", "fetch", "K2 Expedition 2026", "tours.example.com"],
      ["gb.example.org/royalty", "fetch", "Royalty schedule", "gb.example.org"],
    ],
    "pages",
  )
  ok(pages[1].text.includes("9,500") && pages[1].text.includes("USD 5,000 in summer"), "a page searched and fetched keeps both texts")
  eq(G.pagesFrom([{ tool: "webfetch", state: { status: "error", input: { url: "https://x.example/" } } }]), [], "a failed fetch read nothing")
  eq(G.pagesFrom([{ tool: "bash", state: { status: "completed", output: "Source: https://x.example/\nTitle: t\nFetched: d\n---\n" } }]), [], "only web tools")
})

test("chips: numbered by first appearance, one per page, only for pages read", () => {
  const md =
    "Full board is $28,000 for 6+ ([Tours](https://tours.example.com/k2)).\n\nThe royalty is USD 5,000 ([GB](https://www.gb.example.org/royalty/)); see also [Tours](https://tours.example.com/k2/#prices) and [Wiki](https://en.wikipedia.org/wiki/K2)."
  const pages = G.pagesFrom([TOURS, PERMIT])
  const g = G.ground(md, pages, pages)
  eq(Object.fromEntries(Object.entries(g.chips).map(([k, c]) => [k, c.n])), { "tours.example.com/k2": 1, "gb.example.org/royalty": 2 }, "chips")
  eq(g.flagged, 0, "every amount is on its page")
  const s = g.chips["tours.example.com/k2"].snippet
  ok(s && s.match === "28,000" && s.before.includes("6+ members"), `snippet around the amount: ${JSON.stringify(s)}`)
})

test("flag: an amount not on the page its line cites; never on a calculated or approximate line", () => {
  const pages = G.pagesFrom([TOURS, PERMIT])
  const md = [
    "- Local operator rates for Pakistanis: $8,500 – $15,000 ([Tours](https://tours.example.com/k2/)).",
    "- Full board: $29,900 ([Tours](https://tours.example.com/k2/)).",
    "- Royalty: USD 5,000 per person ([GB](https://gb.example.org/royalty)).",
    "- In total about $33,000 – $35,000 ([Tours](https://tours.example.com/k2/)).",
    "- Roughly ~$9,000 with tips ([Tours](https://tours.example.com/k2/)).",
    "- Base camp: $8.5k for 6+ ([Tours](https://tours.example.com/k2/)).",
    "- Royalty USD 9,500 per team, not on that page ([GB](https://gb.example.org/royalty)).",
  ].join("\n")
  const g = G.ground(md, pages, pages)
  eq(g.chips["tours.example.com/k2"].flags, ["$29,900"], "only the full-board figure the page doesn't give (the range's ends are both on the page; 8.5k = 8,500)")
  eq(g.chips["gb.example.org/royalty"].flags, ["USD 9,500"], "the team royalty isn't on the search result cited")
  eq(g.flagged, 2, "count")
})

test("hostile pages: no javascript: or data: page, control and bidi characters gone, text stays text", () => {
  const evil = [
    { tool: "webfetch", state: { status: "completed", input: { url: "https://ok.example/" }, output: "Source: javascript:alert(1)\nTitle: x\nFetched: d\n---\n\nbody" } },
    { tool: "webfetch", state: { status: "completed", input: { url: "data:text/html,<script>alert(1)</script>" }, output: "body" } },
    searchPart([{ title: "Bad", url: "javascript:alert(1)", text: "x" }]),
    fetchPart("https://evil.example/", "Pay‮gnp.exe <img src=x onerror=alert(1)>\u0007", "<script>alert(1)</script> USD 1,000 here"),
  ]
  const pages = G.pagesFrom(evil)
  eq(
    pages.map((p) => p.url),
    ["https://evil.example/"],
    "only http(s) pages",
  )
  eq(pages[0].title, "Paygnp.exe <img src=x onerror=alert(1)>", "bidi and control characters removed; the rest is plain text React escapes")
  const g = G.ground("It costs USD 1,000 ([e](https://evil.example/)).", pages, pages)
  ok(g.chips["evil.example"].snippet.before.includes("<script>"), "page text comes back as a string (rendered as text, never HTML)")
  // A lookalike host is a different page: no chip borrowed from the real one.
  const look = G.ground("See [bank](https://evil.example.com/) and [b2](https://evil.example@attacker.example/).", pages, pages)
  eq(Object.keys(look.chips), [], "lookalikes and userinfo tricks match nothing")
})

test("speed: a long answer over many large pages stays well under a frame budget per answer", () => {
  const big = Array.from({ length: 12 }, (_, i) =>
    fetchPart(`https://p${i}.example/`, `P${i}`, `| a | b |\n| --- | --- |\n${Array.from({ length: 400 }, (_, r) => `| row ${r} | $${(r * 37 + i).toLocaleString("en-US")} |`).join("\n")}`),
  )
  const pages = G.pagesFrom(big)
  const md = Array.from({ length: 300 }, (_, i) => `- Item ${i}: $${(i * 41).toLocaleString("en-US")} ([P](https://p${i % 12}.example/))`).join("\n")
  const t0 = performance.now()
  G.ground(md, pages, pages)
  const ms = performance.now() - t0
  ok(ms < 400, `${ms.toFixed(0)} ms`)
})

// ---------------------------------------------------------------- precision on the labelled sets

const SETS = path.join(ROOT, "scripts", "fixtures", "grounding")
const sets = fs.existsSync(SETS) ? fs.readdirSync(SETS).filter((f) => f.endsWith(".json")) : []
const measured = []
for (const f of sets) {
  const set = JSON.parse(fs.readFileSync(path.join(SETS, f), "utf8"))
  test(`labelled set ${set.set}: every flag has a label`, () => {
    let right = 0
    let wrong = 0
    const missing = []
    for (const it of set.items) {
      const g = G.ground(it.answer, G.pagesFrom(it.turn), G.pagesFrom(it.session))
      for (const x of flagsOf(g)) {
        const l = it.labels[x.amount]
        if (l === "right") right++
        else if (l === "wrong") wrong++
        else missing.push(`${it.id}: ${x.amount}`)
      }
    }
    measured.push({ set: set.set, blind: !!set.blind, right, wrong, answers: set.items.length, recorded: set.precision })
    ok(!missing.length, `unlabelled flags: ${missing.slice(0, 5).join("; ")}`)
  })
}
for (const m of measured) {
  const p = m.right + m.wrong ? m.right / (m.right + m.wrong) : 1
  console.log(`  ${m.set}${m.blind ? " (blind)" : ""}: ${m.right} of ${m.right + m.wrong} flags right (${(p * 100).toFixed(1)}%) over ${m.answers} answers`)
}

test("the flag's default follows the blind precision rule (≥ 95%, docs/QUALITY.md Q4)", () => {
  const blind = measured.filter((m) => m.blind && m.recorded)
  ok(blind.length, "a blind set with its recorded precision")
  const worst = Math.min(...blind.map((m) => m.recorded))
  // A precision needs flags behind it: at least 30 blind flags before 95% can switch the flag on.
  const flags = blind.reduce((n, m) => n + m.right + m.wrong, 0)
  eq(G.SOURCE_FLAGS_DEFAULT, worst >= 0.95 && flags >= 30, `SOURCE_FLAGS_DEFAULT with blind precision ${worst} over ${flags} flags`)
})

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} tests passed`)
process.exit(failed ? 1 : 0)
