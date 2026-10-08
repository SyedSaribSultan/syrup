#!/usr/bin/env node
/**
 * Runs syrup's deterministic answer checks (src/lib/answer-checks) on an exported chat and prints
 * what they find, answer by answer. No app, no network, no model calls.
 *
 *   pnpm eval:check <export.md|export.json> [--json] [--no-hints] [--rate USD/PKR=280] [--budget 15000]
 *
 *   <export>    a syrup.transcript v1 export: the share link's /md or /json, `pnpm chat:export`
 *               (with or without --json / --debug), or the Share dialog's Export buttons
 *   --json      print the findings as JSON instead of the report
 *   --no-hints  leave hints out of the report (they never change the exit code)
 *   --rate      a reference rate for the currency check, e.g. USD/PKR=280 (repeatable); the
 *               built-in ones are dated and only need to be within 1.5x
 *   --budget    the context budget in tokens (default 15000, docs/QUALITY.md §7)
 *
 * Exit 0: no errors (warnings and hints may remain). 1: at least one error. 2: bad arguments or not an export.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { loadChecks } from "./eval/load-checks.mjs"

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const values = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []))
const positional = args.filter((a, i) => !a.startsWith("--") && !["--rate", "--budget"].includes(args[i - 1]))

if (flag("--help") || flag("-h") || positional.length !== 1) {
  console.error("usage: pnpm eval:check <export.md|export.json> [--json] [--no-hints] [--rate USD/PKR=280] [--budget 15000]")
  process.exit(flag("--help") || flag("-h") ? 0 : 2)
}

const L = await loadChecks()
const rates = structuredClone(L.REFERENCE_RATES)
for (const r of values("--rate")) {
  const m = /^([A-Z]{3})\/([A-Z]{3})=([\d.]+)$/i.exec(r)
  if (!m) {
    console.error(`--rate ${r}: write it as USD/PKR=280`)
    process.exit(2)
  }
  ;(rates[m[1].toUpperCase()] ??= {})[m[2].toUpperCase()] = Number(m[3])
}
const budget = values("--budget").length ? Number(values("--budget").at(-1)) : L.CONTEXT_BUDGET

const file = positional[0]
let src
try {
  src = readFileSync(file, "utf8")
} catch (err) {
  console.error(`Can't read ${file}: ${err.code ?? err.message}`)
  process.exit(2)
}
let transcript
try {
  transcript = L.parseTranscript(src)
} catch (err) {
  console.error(`${file} is not a syrup chat export: ${err.message}`)
  process.exit(2)
}
const report = L.checkTranscript(transcript, { referenceRates: rates, contextBudget: budget })

if (flag("--json")) {
  process.stdout.write(`${JSON.stringify({ file: path.basename(file), ...report }, null, 2)}\n`)
  process.exit(report.counts.error ? 1 : 0)
}

const hints = !flag("--no-hints")
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`
const SEV = { error: "ERROR", warn: "warn ", hint: "hint " }
const out = []
const rateList = Object.entries(rates.USD ?? {})
  .map(([k, v]) => `${k} ${v}`)
  .join(", ")
out.push(`eval:check · ${file}`)
out.push(`"${report.title}" · ${report.form} export · ${plural(report.messages, "message")} · ${plural(report.questions, "question")} · reference rates per USD: ${rateList} (as of ${L.REFERENCE_RATES_AS_OF}) · context budget ${Math.round(budget / 1000)}k`)
out.push("")

const order = { error: 0, warn: 1, hint: 2 }
let shown = 0
for (const r of report.reports) {
  const findings = r.findings.filter((f) => hints || f.severity !== "hint").sort((a, b) => order[a.severity] - order[b.severity])
  if (!findings.length) continue
  shown++
  out.push(`#${r.index} · Assistant${r.label ? ` · ${r.label}` : ""} · question ${r.turn}${r.question ? `: "${clip(r.question, 60)}"` : ""}`)
  for (const f of findings) {
    out.push(`  ${SEV[f.severity]}  ${f.check.padEnd(11)}  ${f.message}`)
    const where = typeof f.evidence.line === "number" ? `answer line ${f.evidence.line}: ` : ""
    if (f.evidence.excerpt && f.check !== "context" && !Array.isArray(f.evidence.amounts)) out.push(`  ${" ".repeat(18)}  > ${clip(`${where}${f.evidence.excerpt.replace(/\s+/g, " ")}`, 150)}`)
  }
  out.push("")
}
if (!shown) out.push("No findings.", "")

const c = report.counts
out.push(`Summary: ${plural(c.error, "error")} · ${plural(c.warn, "warning")} · ${plural(c.hint, "hint")}${hints ? "" : " (hints not shown)"}`)
for (const [check, n] of Object.entries(report.byCheck)) {
  const bits = [n.error && plural(n.error, "error"), n.warn && plural(n.warn, "warning"), n.hint && plural(n.hint, "hint")].filter(Boolean)
  out.push(`  ${check.padEnd(12)} ${bits.join(", ")}`)
}
out.push(c.error ? "Result: FAIL (an error means a number in the answer is provably wrong) · exit 1" : "Result: PASS (no errors) · exit 0")
console.log(out.join("\n"))
process.exit(c.error ? 1 : 0)
