/**
 * What an eval case is made of (scripts/fixtures/eval/cases/*.mjs) and the checks it can use.
 *
 *   export default defineCase({
 *     id, title, tags: ["smoke", …],
 *     seed: { transcript: "transcripts/k2.md", turns: 6 },   // optional: user turns 1..6 imported, not run
 *     cassette: "cassettes/k2-pkr.json",                     // optional: what websearch/webfetch answer
 *     workspace: "workspaces/fix-failing-test",              // optional: files copied in (hidden/ stays out)
 *     turns: ["in PKR"],                                     // the live turn(s)
 *     checks: [c.answered(), c.noErrors(["currency"], { column: "numbers" }), …],
 *   })
 *
 * A check is `{ name, column, info, gap, run(trial) => { pass: true | false | null, detail } }`; null means "not applicable".
 * Options every check takes:
 *   column   where the table shows it (numbers, sums, prov, urls, claims, tests, tools, tokens, done)
 *   info     shown, never fails the case
 *   gap      a known gap: it must FAIL today. Its failure doesn't fail the case; once it passes the
 *            run fails with "gap closed" until the note is deleted (like the UI harness, TESTING.md §3.3)
 *
 * A trial is what the runner hands each check: { live: parsed messages of the live turn(s),
 * report: the answer checks' findings on them, answers: router answers of the live turn(s),
 * workspace, seedDir, runTests(cmd) }.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "eval")

export function defineCase(c) {
  for (const k of ["id", "turns", "checks"]) if (!c[k]) throw new Error(`eval case: "${k}" is required`)
  return { tags: [], ...c }
}

const mk = (column, run, opts = {}) => ({ run, column: opts.column ?? column, name: opts.name ?? column, info: !!opts.info, gap: opts.gap ?? null })

/** Findings of these checks with these severities in the live turn's answers. */
const findings = (trial, ids, sev = ["error"]) => trial.report.filter((f) => ids.includes(f.check) && sev.includes(f.severity))

export const checks = {
  /** The live turn ended with an answer: text, no error, not cut off. */
  answered: (opts) =>
    mk(
      "done",
      (t) => {
        const last = t.live.filter((m) => m.role === "assistant").at(-1)
        if (!last) return { pass: false, detail: "no assistant message" }
        if (last.meta.error) return { pass: false, detail: `error: ${last.meta.error.slice(0, 120)}` }
        if (!last.text.trim()) return { pass: false, detail: "the last message has no text" }
        return { pass: true, detail: `${last.text.length} chars` }
      },
      opts,
    ),

  /** No finding of these answer checks (src/lib/answer-checks) in the live turn: e.g. ["currency"], ["table-total", "list-total"]. */
  noErrors: (ids, opts = {}) =>
    mk(
      opts.column ?? ids[0],
      (t) => {
        const f = findings(t, ids, opts.severities ?? ["error"])
        return { pass: f.length === 0, detail: f.length ? f.map((x) => x.message).join(" | ").slice(0, 400) : "none" }
      },
      opts,
    ),

  /** Largest input-token count of one model request in the live turn (router answers, title calls left out). */
  lastTurnInputTokens: ({ max, ...opts }) =>
    mk(
      "tokens",
      (t) => {
        const n = Math.max(0, ...t.answers.map((a) => a.inputTokens ?? 0))
        if (!t.answers.length) return { pass: null, detail: "no router answer" }
        return { pass: n <= max, detail: `${n} input tokens (budget ${max})`, value: n }
      },
      { name: "tokens", ...opts },
    ),

  /** The last answer matches every pattern in `all` and at least one in `any`. */
  contains: ({ all = [], any = [], ...opts }) =>
    mk(
      "claims",
      (t) => {
        const text = t.live.filter((m) => m.role === "assistant").map((m) => m.text).join("\n")
        const missing = all.filter((re) => !re.test(text))
        const anyOk = !any.length || any.some((re) => re.test(text))
        return { pass: !missing.length && anyOk, detail: missing.length ? `missing ${missing.join(", ")}` : anyOk ? "found" : `none of ${any.join(", ")}` }
      },
      opts,
    ),

  /**
   * The answer gives this amount (Q3's numeric set): some amount in `cur` within `tol` (relative, default 0.5%) of
   * `value`, or a range whose ends are within `tol` of `lo` and `hi`. Parsed by the answer checks' own money parser,
   * so "PKR 1.52 crore", "1,51,84,800 PKR" and "151.85 lakh" all count.
   */
  amount: ({ cur, value, lo, hi, tol = 0.005, ...opts }) =>
    mk(
      "numbers",
      (t) => {
        const text = t.live.filter((m) => m.role === "assistant").map((m) => m.text).join("\n")
        const near = (a, b) => Math.abs(a - b) <= tol * Math.abs(b)
        const all = t.parseAmounts(text).filter((a) => a.cur === cur)
        const hit = all.find((a) => (value !== undefined ? near(a.lo, value) && near(a.hi, value) : near(a.lo, lo) && near(a.hi, hi)))
        const want = value !== undefined ? `${value}` : `${lo}–${hi}`
        return { pass: !!hit, detail: hit ? `found "${hit.text.trim()}"` : `no ${cur} ${want} (±${tol * 100}%) among ${all.map((a) => a.text.trim()).slice(0, 6).join(", ") || "no amounts"}` }
      },
      { name: `amount ${cur}`, ...opts },
    ),

  /** Whether the live turn called this tool (as the model names it: "syrup_calc"). */
  usedTool: (name, opts = {}) =>
    mk(
      "tools",
      (t) => {
        const n = t.live.flatMap((m) => m.tools ?? []).filter((x) => x.tool === name).length
        return { pass: n > 0, detail: n ? `${n} call(s)` : "not called" }
      },
      { name: `used ${name}`, ...opts },
    ),

  /** A Markdown table with a Total row in the answer (so the sums check has something to check). */
  hasTotalRow: (opts) =>
    mk(
      "sums",
      (t) => {
        const text = t.live.filter((m) => m.role === "assistant").map((m) => m.text).join("\n")
        const ok = /^\s*\|[^\n]*\btotal\b[^\n]*\|/im.test(text)
        return { pass: ok, detail: ok ? "table has a Total row" : "no table with a Total row" }
      },
      { name: "total-row", ...opts },
    ),

  /** Files the agent must leave alone (relative to the workspace), compared with the seed copy. */
  untouched: (files, opts) =>
    mk(
      "tests",
      (t) => {
        const changed = files.filter((f) => {
          const a = path.join(t.workspace, f)
          const b = path.join(t.seedDir, f)
          return !fs.existsSync(a) || fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8")
        })
        return { pass: !changed.length, detail: changed.length ? `changed: ${changed.join(", ")}` : "unchanged" }
      },
      { name: "untouched", ...opts },
    ),

  /**
   * Hidden tests: the case's `hidden/` folder is copied into the workspace only after the agent
   * finished, then `cmd` runs there. Exit 0 passes.
   */
  hiddenTests: ({ cmd, timeoutMs = 60_000, ...opts }) =>
    mk(
      "tests",
      (t) => {
        const r = t.runTests(cmd, timeoutMs)
        return { pass: r.status === 0, detail: r.status === 0 ? "hidden tests pass" : `exit ${r.status}: ${r.tail}` }
      },
      { name: "hidden-tests", ...opts },
    ),

  /**
   * The judge (docs/QUALITY.md Q1, "Judged checks"): is this claim supported by what the agent read?
   * Not built yet (Q1b). With `pnpm eval --judge` it says so; it never passes or fails a case.
   */
  judged: ({ claim, ...opts }) => mk("claims", () => ({ pass: null, detail: `judge not built yet (Q1b): ${claim}` }), { name: "judge", ...opts }),
}

/** Runs a command in the workspace (used by hiddenTests); returns { status, tail }. */
export function runIn(dir, cmd, timeoutMs) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: dir, encoding: "utf8", timeout: timeoutMs, windowsHide: true })
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim()
  return { status: r.status ?? (r.error ? -1 : 1), tail: out.split("\n").slice(-6).join(" ⏎ ").slice(-400) }
}
