#!/usr/bin/env node
/**
 * Prints `pnpm eval` results: the run table (docs/QUALITY.md Q1, the evals design §4 "Reporting"),
 * known gaps, and a per-case trend across runs. Shared with scripts/eval.mjs, which prints the same
 * table at the end of a run.
 *
 *   pnpm eval:report                 # the latest run
 *   pnpm eval:report <run folder>    # one run (node_modules/.cache/syrup-eval/<stamp>/)
 *   pnpm eval:report --trend [10]    # each case over the last N runs: result, input tokens, first text
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ROOT } from "./load-checks.mjs"

export const CACHE = path.join(ROOT, "node_modules", ".cache", "syrup-eval")
export const BASELINE = path.join(ROOT, "scripts", "fixtures", "eval-baseline.json")
const COLUMNS = ["numbers", "sums", "prov", "urls", "claims", "tests"]

const pad = (s, n) => String(s).padEnd(n)
const k = (n) => (n == null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const secs = (n) => (n == null ? "–" : `${(n / 1000).toFixed(1)}s`)
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}

/** Trials that count toward a result: not skipped for quota, not off-script. */
export const counted = (c) => c.trials.filter((t) => t.status === "pass" || t.status === "fail" || t.status === "error")

/** "x/y" for one column over the counted trials, "–" when no check reports in it. Gap and judge checks stay out. */
function column(c, col) {
  let y = 0
  let x = 0
  for (const t of counted(c)) {
    const cs = (t.checks ?? []).filter((r) => r.column === col && r.pass !== null && !r.gap)
    if (!cs.length) continue
    y++
    if (cs.every((r) => r.pass || r.info)) x++
  }
  return y ? `${x}/${y}` : "–"
}

function tokensCell(c) {
  const ts = counted(c).map((t) => t.inputTokensLast).filter((n) => n != null)
  if (!ts.length) return "–"
  const max = Math.max(...ts)
  const check = counted(c)
    .flatMap((t) => t.checks ?? [])
    .find((r) => r.name === "tokens")
  if (!check) return k(max)
  return `${k(max)} ${check.gap ? "gap" : counted(c).every((t) => (t.checks ?? []).find((r) => r.name === "tokens")?.pass) ? "✓" : "✗"}`
}

function modelsCell(c) {
  const n = new Map()
  for (const t of counted(c)) for (const m of t.models ?? []) n.set(m, (n.get(m) ?? 0) + 1)
  return [...n].map(([m, x]) => (x > 1 ? `${m} ×${x}` : m)).join(", ") || "–"
}

function vsBase(c, base) {
  const b = base?.cases?.[c.id]
  if (c.result === "SKIP" || c.result === "OFF") return b ? `(was ${b.result})` : ""
  if (!b) return "new"
  if (b.result === c.result) return "="
  return c.result === "FAIL" ? `↓ (was ${b.result})` : `↑ (was ${b.result})`
}

/** The run table as lines. `base`: the committed baseline (or null). */
export function formatRun(run, base = null) {
  const out = []
  const when = new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ")
  out.push(`syrup eval · ${run.set} · ${when} UTC · ${run.commit} · ${run.model} · ${run.cases.length} case${run.cases.length === 1 ? "" : "s"}`)
  const head = ["case", "trials", "result", ...COLUMNS, "tokens(last)", "ttft", "total", "models", "vs base"]
  const rows = run.cases.map((c) => {
    const cnt = counted(c)
    const passed = cnt.filter((t) => t.status === "pass").length
    const skipped = c.trials.filter((t) => t.status === "skipped").length
    const off = c.trials.filter((t) => t.status === "off-script").length
    const trials = `${passed}/${cnt.length}${skipped ? ` +${skipped} skip` : ""}${off ? ` +${off} off` : ""}`
    return [c.id, trials, c.result, ...COLUMNS.map((col) => column(c, col)), tokensCell(c), secs(median(cnt.map((t) => t.ttftMs))), secs(median(cnt.map((t) => t.totalMs))), modelsCell(c), vsBase(c, base)]
  })
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  out.push(head.map((h, i) => pad(h, widths[i])).join("  ").trimEnd())
  for (const r of rows) out.push(r.map((v, i) => pad(v, widths[i])).join("  ").trimEnd())
  const t = run.totals
  const web = t.replay.hit + t.replay.fuzzy + t.replay.fallback + t.replay.miss
  const hits = web ? `${Math.round(((t.replay.hit + t.replay.fuzzy + t.replay.fallback) / web) * 100)}% (${t.replay.hit} exact, ${t.replay.fuzzy} fuzzy, ${t.replay.fallback} fallback, ${t.replay.miss} miss)` : "no web calls"
  out.push(`requests ${t.requests} · judge calls 0 (Q1b) · Exa calls 0 · cassette hits ${hits} · off-script ${t.offScript} · skipped (quota) ${t.skipped} · ${Math.round(t.wallMs / 1000)}s`)

  // Details worth reading: why each failing or skipped trial ended where it did.
  const notes = []
  for (const c of run.cases)
    for (const tr of c.trials) {
      if (tr.status === "pass") continue
      const why = tr.status === "fail" ? (tr.checks ?? []).filter((r) => r.pass === false && !r.info && !r.gap).map((r) => `${r.name}: ${r.detail}`).join(" · ") : tr.reason
      notes.push(`  ${c.id} #${tr.n} ${tr.status}: ${String(why ?? "").slice(0, 300)}`)
    }
  if (notes.length) out.push("", "Not passing:", ...notes)

  const gaps = run.cases.flatMap((c) => (c.gaps ?? []).map((g) => ({ ...g, id: c.id })))
  if (gaps.length) {
    out.push("", "Known gaps (must fail until their fix lands):")
    for (const g of gaps) out.push(`  ${g.id} · ${g.name}: ${g.status === "closed" ? "PASSES NOW, so the gap is closed: delete its gap note in the case file" : "still failing as expected"} (${g.detail})`, `    ${g.why}`)
  }
  if (run.regressions?.length) out.push("", `REGRESSION: ${run.regressions.join(", ")} passed in the baseline and fail now. This blocks the push until someone reads the transcripts above (docs/TESTING.md §1.2): fix it, or accept it with \`pnpm eval --update-baseline\` and say why in the commit.`)
  if (run.gapsClosed?.length) out.push("", `GAP CLOSED: ${run.gapsClosed.join(", ")}. Delete the gap note in the same change, so the check guards the fix.`)
  if (run.cases.length && run.cases.every((c) => c.result === "SKIP" || c.result === "OFF")) out.push("", "NOTHING MEASURED: every case was skipped (quota) or went off-script. Run again later; this is not a pass.")
  out.push("", `raw results and transcripts: ${path.relative(ROOT, run.dir)}`)
  return out
}

export function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE, "utf8"))
  } catch {
    return null
  }
}

/** Writes the baseline from a run: measured cases replace their entry, skipped ones keep the old one. */
export function writeBaseline(run, old) {
  const cases = { ...(old?.cases ?? {}) }
  for (const c of run.cases) {
    if (c.result === "SKIP" || c.result === "OFF") continue
    const cnt = counted(c)
    cases[c.id] = { result: c.result, passes: cnt.filter((t) => t.status === "pass").length, trials: cnt.length, tokensLast: Math.max(0, ...cnt.map((t) => t.inputTokensLast ?? 0)) || null }
  }
  const out = { note: "Per-case results `pnpm eval` compares against (docs/TESTING.md §1.2). Update only on purpose: pnpm eval --update-baseline, and say why in the commit.", updatedAt: new Date().toISOString().slice(0, 10), commit: run.commit, cases }
  fs.writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`)
  return out
}

/** Every run folder with a results.json, oldest first. */
export function runs() {
  if (!fs.existsSync(CACHE)) return []
  return fs
    .readdirSync(CACHE)
    .filter((d) => fs.existsSync(path.join(CACHE, d, "results.json")))
    .sort()
    .map((d) => JSON.parse(fs.readFileSync(path.join(CACHE, d, "results.json"), "utf8")))
}

function trend(n) {
  const list = runs().slice(-n)
  if (!list.length) return ["No runs yet: pnpm eval --set smoke"]
  const ids = [...new Set(list.flatMap((r) => r.cases.map((c) => c.id)))]
  const out = [`syrup eval · trend over the last ${list.length} run(s), oldest first`]
  for (const id of ids) {
    const cells = list.map((r) => {
      const c = r.cases.find((x) => x.id === id)
      return c ? { PASS: "P", FAIL: "F", SKIP: "s", OFF: "o" }[c.result] : "·"
    })
    const toks = list.map((r) => r.cases.find((x) => x.id === id)).filter(Boolean).map((c) => Math.max(0, ...counted(c).map((t) => t.inputTokensLast ?? 0)))
    const ttft = list.map((r) => r.cases.find((x) => x.id === id)).filter(Boolean).map((c) => median(counted(c).map((t) => t.ttftMs)))
    out.push(`${pad(id, 20)} ${cells.join(" ")}   tokens ${toks.map(k).join("→")}   ttft ${ttft.map(secs).join("→")}`)
  }
  out.push("P pass · F fail · s skipped (quota) · o off-script · · not run")
  return out
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const args = process.argv.slice(2)
  if (args.includes("--trend")) {
    const n = Number(args[args.indexOf("--trend") + 1]) || 10
    console.log(trend(n).join("\n"))
    process.exit(0)
  }
  const which = args.find((a) => !a.startsWith("--"))
  const all = runs()
  const run = which && which !== "latest" ? JSON.parse(fs.readFileSync(path.join(path.resolve(which), "results.json"), "utf8")) : all.at(-1)
  if (!run) {
    console.error("No eval runs yet. Run: pnpm eval --set smoke")
    process.exit(1)
  }
  console.log(formatRun(run, loadBaseline()).join("\n"))
}
