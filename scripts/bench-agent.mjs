#!/usr/bin/env node
/**
 * Times real agent turns the way a user feels them. Drives a running syrup
 * (local: `pnpm dev`, the proxy at /api/oc) with a few prompts and records,
 * per turn: time to the first streamed text (the first message.part.delta of
 * an assistant text part, which is when the chat shows it), time to the first tool call,
 * total time, which model answered, how many attempts the router needed and
 * whether it fell over to another model. Spends real free-tier quota.
 *
 *   node scripts/bench-agent.mjs                 # all prompts, once
 *   node scripts/bench-agent.mjs --set quick     # one-word answers only
 *   node scripts/bench-agent.mjs --runs 3        # each prompt three times
 *   node scripts/bench-agent.mjs --dir C:\path   # a specific workspace folder
 *   node scripts/bench-agent.mjs --model syrup/fast
 *
 * Writes the raw rows to node_modules/.cache/syrup-bench/<timestamp>.json so
 * runs can be compared later.
 */
import fs from "node:fs"
import path from "node:path"
import { driver, fmt, ms, realAnswers, scratchDir } from "./lib/drive.mjs"

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]] : [])).filter((x) => x.length))
const BASE = (args.base ?? "http://127.0.0.1:3000").replace(/\/$/, "")
const RUNS = Number(args.runs ?? 1)
const SET = args.set ?? "all"
const MODEL = args.model ? { providerID: args.model.split("/")[0], modelID: args.model.split("/").slice(1).join("/") } : undefined

/** The bench's scratch project: a git-initialised folder with a README and a tiny util.py. */
function benchDir() {
  const dir = scratchDir("syrup-bench")
  fs.writeFileSync(path.join(dir, "README.md"), "# bench\n\nA scratch project for timing syrup.\n")
  fs.writeFileSync(path.join(dir, "util.py"), "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n")
  return dir
}

const PROMPTS = {
  quick: [
    { id: "hello", text: "Reply with one word: ready." },
    { id: "explain", text: "In two sentences, what does util.py do? Read it first." },
  ],
  tools: [
    { id: "list", text: "List the files in this folder and say which one you'd start reading. One short paragraph." },
    { id: "write", text: "Create hello.py that prints the word hello, then run it with python and tell me the output. Nothing else." },
    { id: "edit", text: "In util.py add a mul(a, b) function next to the others. Then reply with one word: done." },
  ],
  hard: [{ id: "plan", text: "Plan how you would add a command-line flag parser to util.py so each function can be called from a shell, and explain the trade-offs between argparse and click. Do not write code; outline the steps." }],
}
const picked = SET === "all" ? Object.values(PROMPTS).flat() : (PROMPTS[SET] ?? PROMPTS.quick)

const dir = args.dir ?? benchDir()
const d = driver({ base: BASE, dir })

async function runOne(prompt, run) {
  const session = await d.createSession()
  const marks = await d.runTurn(session.id, prompt.text, { model: MODEL })
  const ans = await d.answers(session.id)
  const real = realAnswers(ans)
  const first = real[0]
  const models = [...new Set(real.map((a) => `${a.providerId}/${a.modelId}`))]
  return {
    prompt: prompt.id,
    run,
    session: session.id,
    firstTextMs: ms(marks.sent, marks.firstText),
    firstToolMs: ms(marks.sent, marks.firstTool),
    firstAnythingMs: ms(marks.sent, [marks.firstText, marks.firstTool, marks.firstReasoning].filter(Boolean).sort((a, b) => a - b)[0]),
    totalMs: ms(marks.sent, marks.idle),
    steps: marks.steps ?? 0,
    tools: marks.tools ?? 0,
    routerTtftMs: first?.ttftMs ?? null,
    attempts: real.reduce((n, a) => n + (a.attempts ?? 1), 0),
    requests: real.length,
    models,
    failover: real.some((a) => (a.attempts ?? 1) > 1) || models.length > 1,
    partial: real.some((a) => a.partial),
    error: marks.error ?? null,
  }
}

console.log(`syrup bench · ${BASE} · workspace ${dir} · ${picked.length} prompt(s) × ${RUNS}${MODEL ? ` · model ${args.model}` : ""}\n`)
const rows = []
for (let run = 1; run <= RUNS; run++) {
  for (const p of picked) {
    process.stdout.write(`${p.id.padEnd(8)} run ${run} … `)
    try {
      const r = await runOne(p, run)
      rows.push(r)
      console.log(`first text ${fmt(r.firstTextMs).padStart(7)} · first tool ${fmt(r.firstToolMs).padStart(7)} · total ${fmt(r.totalMs).padStart(7)} · ${r.steps} step(s), ${r.tools} tool(s) · ${r.models.join(" → ") || "no router row"}${r.failover ? " · FAILOVER" : ""}${r.partial ? " · cut off" : ""}${r.error ? ` · ERROR ${r.error}` : ""}`)
    } catch (err) {
      console.log(`failed: ${err instanceof Error ? err.message : err}`)
      rows.push({ prompt: p.id, run, error: String(err) })
    }
  }
}

const ok = rows.filter((r) => !r.error && r.totalMs != null)
const med = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}
console.log(`\n${ok.length}/${rows.length} turns finished · median first text ${fmt(med(ok.map((r) => r.firstTextMs)))} · median first anything ${fmt(med(ok.map((r) => r.firstAnythingMs)))} · median total ${fmt(med(ok.map((r) => r.totalMs)))} · failovers ${ok.filter((r) => r.failover).length} · cut off ${ok.filter((r) => r.partial).length}`)
const perModel = new Map()
for (const r of ok) for (const m of r.models) perModel.set(m, (perModel.get(m) ?? 0) + 1)
if (perModel.size) console.log(`models: ${[...perModel].map(([m, n]) => `${m} ×${n}`).join(", ")}`)

const outDir = path.join(process.cwd(), "node_modules", ".cache", "syrup-bench")
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
fs.writeFileSync(out, JSON.stringify({ base: BASE, dir, model: args.model ?? "default", rows }, null, 2))
console.log(`raw rows: ${out}`)
