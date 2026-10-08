#!/usr/bin/env node
/**
 * `pnpm eval`: answer-quality evals on real models with recorded web results (docs/QUALITY.md Q1,
 * docs/TESTING.md §1.2). Spends a little free quota; never Exa's, never scarce backends'.
 *
 *   pnpm eval --set smoke              # Tier 1: the smoke cases, 1 trial each; a failure runs 2 more
 *   pnpm eval --case k2-pkr --trials 3 # one case (or a,b,c), N trials each
 *   pnpm eval --set full --trials 3    # Tier 2 (every case; the full set grows to ~20 cases)
 *   pnpm eval --list                   # cases and their tags
 *
 * Flags: --model <provider/model> (default syrup/auto) · --no-rerun · --update-baseline · --judge
 * (says the judge is Q1b) · --keep (leave the eval's syrup running and print its URL) ·
 * --timeout <s> per turn (default 300)
 *
 * How it runs, per case: a fresh scratch workspace (the case's files copied in, `hidden/` kept out),
 * earlier turns imported with `opencode import` (scripts/eval/seed.mjs), the case's cassette swapped
 * in for the plugin's replay tools, the live turn(s) sent through the proxy like a user would
 * (scripts/lib/drive.mjs), then the chat exported (syrup.transcript v1) and checked: the answer
 * checks (src/lib/answer-checks), hidden tests, input tokens, first text. Results and every
 * transcript go to node_modules/.cache/syrup-eval/<stamp>/.
 *
 * Isolation: its own syrup (scripts/eval/host.ts: the real engine, router, vault and memory modules
 * in a plain Node process), on free ports (never 3000/3300/4096/4210/4396/4410), with its own
 * SYRUP_HOME, SYRUP_DB and OpenCode XDG folders and home, so nothing touches the dev server or your
 * chats. Your provider keys are read where the dev server reads them (the local vault, read-only via
 * SYRUP_KEYS_DB / SYRUP_VAULT_HOME, or the provider env variables) and are never copied or printed.
 * The engine runs with SYRUP_EVAL=1 (the router keeps eval traffic off scarce backends) and
 * SYRUP_EVAL_REPLAY (websearch/webfetch answer from the cassette).
 *
 * Exit 0: no regression. 1: a case that passed in scripts/fixtures/eval-baseline.json fails now, or a
 * known gap passes (delete its note). Quota errors are "skipped", never failures. 2: could not start.
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { FIXTURES, runIn } from "./eval/kit.mjs"
import { loadChecks, ROOT } from "./eval/load-checks.mjs"
import { CACHE, counted, formatRun, loadBaseline, writeBaseline } from "./eval/report.mjs"
import { buildSeed } from "./eval/seed.mjs"
import { driver, ms, realAnswers } from "./lib/drive.mjs"

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2).filter((a) => a !== "--")
const flag = (n) => argv.includes(n)
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d)
const SET = opt("--set", flag("--case") ? "custom" : "smoke")
const TRIALS = Number(opt("--trials", 1))
const MODEL_ARG = opt("--model")
const MODEL = MODEL_ARG ? { providerID: MODEL_ARG.split("/")[0], modelID: MODEL_ARG.split("/").slice(1).join("/") } : undefined
const TURN_TIMEOUT = Number(opt("--timeout", 300)) * 1000
const BUDGET = 15_000
const FORBIDDEN_PORTS = new Set([3000, 3300, 4096, 4210, 4396, 4410])

// ---------------------------------------------------------------- cases

async function loadCases() {
  const dir = path.join(FIXTURES, "cases")
  const out = []
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) out.push((await import(pathToFileURL(path.join(dir, f)).href)).default)
  return out
}

const all = await loadCases()
if (flag("--list")) {
  for (const c of all) console.log(`${c.id.padEnd(20)} [${c.tags.join(", ")}] ${c.title ?? ""}`)
  process.exit(0)
}
const wanted = opt("--case")?.split(",").map((s) => s.trim())
const cases = wanted ? all.filter((c) => wanted.includes(c.id)) : SET === "full" ? all : all.filter((c) => c.tags.includes(SET))
if (wanted && cases.length !== wanted.length) {
  console.error(`Unknown case: ${wanted.filter((w) => !all.some((c) => c.id === w)).join(", ")}. pnpm eval --list shows them.`)
  process.exit(2)
}
if (!cases.length) {
  console.error(`No cases in set "${SET}". pnpm eval --list shows them.`)
  process.exit(2)
}
if (flag("--judge")) console.log("Note: the judge is not built yet (docs/QUALITY.md Q1b). Judged checks report – and never pass or fail a case.\n")

// ---------------------------------------------------------------- the isolated syrup

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => (FORBIDDEN_PORTS.has(port) ? freePort().then(resolve, reject) : resolve(port)))
    })
  })
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const runDir = path.join(CACHE, stamp)
const engineDir = path.join(runDir, "engine")
const wsRoot = path.join(os.tmpdir(), `syrup-eval-${stamp}`)
const cassetteFile = path.join(runDir, "cassette.json")
for (const d of [runDir, wsRoot, path.join(engineDir, "home"), ...["config", "data", "state"].map((x) => path.join(engineDir, "xdg", x))]) fs.mkdirSync(d, { recursive: true })
// The engine's download cache (ripgrep, the models.dev catalog) is kept between runs; nothing of the user's is in it.
const engineCache = path.join(CACHE, "engine-cache")
const rg = path.join(os.homedir(), ".cache", "opencode", "bin", process.platform === "win32" ? "rg.exe" : "rg")
const rgCopy = path.join(engineCache, "opencode", "bin", path.basename(rg))
if (!fs.existsSync(rgCopy) && fs.existsSync(rg)) {
  fs.mkdirSync(path.dirname(rgCopy), { recursive: true })
  fs.copyFileSync(rg, rgCopy)
}
fs.writeFileSync(cassetteFile, JSON.stringify({ format: "syrup.cassette", version: 1, entries: [] }))

/** Where the dev server reads the local vault: the same database and vault.key, read-only, never copied. */
function vaultLocation() {
  const db = process.env.SYRUP_DB || `file:${path.join(ROOT, "data", "syrup.db")}`
  const home = process.env.SYRUP_HOME
    ? path.resolve(process.env.SYRUP_HOME)
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "syrup")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "syrup")
  return { db, home }
}

const [hostPort, routerPort, enginePort] = [await freePort(), await freePort(), await freePort()]
const vault = vaultLocation()
const engineEnv = (() => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(OPENCODE_|XDG_)/i.test(k) || (/^SYRUP_/i.test(k) && k !== "SYRUP_VAULT_KEY")) delete env[k]
  const home = path.join(engineDir, "home")
  return {
    ...env,
    SYRUP_MODE: "local",
    SYRUP_HOME: path.join(runDir, "syrup-home"),
    SYRUP_DB: `file:${path.join(runDir, "data", "syrup.db")}`,
    SYRUP_KEYS_DB: vault.db,
    SYRUP_VAULT_HOME: vault.home,
    SYRUP_ROUTER_PORT: String(routerPort),
    SYRUP_WORKSPACE: wsRoot,
    SYRUP_EVAL: "1",
    SYRUP_EVAL_REPLAY: cassetteFile,
    SYRUP_EVAL_HOST_PORT: String(hostPort),
    OPENCODE_PORT: String(enginePort),
    OPENCODE_HOSTNAME: "127.0.0.1",
    XDG_CONFIG_HOME: path.join(engineDir, "xdg", "config"),
    XDG_DATA_HOME: path.join(engineDir, "xdg", "data"),
    XDG_STATE_HOME: path.join(engineDir, "xdg", "state"),
    XDG_CACHE_HOME: engineCache,
    OPENCODE_TEST_HOME: home,
    HOME: home,
    USERPROFILE: home,
    NEXT_TELEMETRY_DISABLED: "1",
  }
})()

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  else
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
}

async function startHost() {
  const b = spawnSync(process.execPath, [path.join(ROOT, "sidecar", "build.mjs")], { cwd: ROOT, encoding: "utf8" })
  if (b.status !== 0) throw new Error(`sidecar/build.mjs failed:\n${b.stderr}`)
  const hostFile = path.join(CACHE, "host.mjs")
  await build({ entryPoints: [path.join(ROOT, "scripts", "eval", "host.ts")], outfile: hostFile, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", alias: { "@": path.join(ROOT, "src") }, logLevel: "warning" })
  const logFile = path.join(runDir, "host.log")
  const fd = fs.openSync(logFile, "w")
  const child = spawn(process.execPath, [hostFile], { cwd: ROOT, env: engineEnv, stdio: ["ignore", fd, fd], detached: process.platform !== "win32", windowsHide: true })
  fs.closeSync(fd)
  const base = `http://127.0.0.1:${hostPort}`
  const t0 = Date.now()
  while (Date.now() - t0 < 120_000) {
    if (child.exitCode !== null) throw new Error(`the eval's syrup exited (${child.exitCode}); see ${path.relative(ROOT, logFile)}`)
    const ok = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (ok) return { child, base, ms: Date.now() - t0 }
    await new Promise((r) => setTimeout(r, 500))
  }
  killTree(child)
  throw new Error(`the eval's syrup did not answer within 120 s; see ${path.relative(ROOT, logFile)}`)
}

// ---------------------------------------------------------------- one trial

const L = await loadChecks()
const QUOTA = /rate.?limit|quota|\b429\b|resource.?exhausted|cooling|syrup_scarce_only|scarce|no connected provider|too many requests|insufficient.?credits/i

/**
 * OpenCode retrying a model request: wait out a short retry, stop on a long or repeated one. Only a quota-shaped
 * message makes the trial "skipped"; anything else (a router crash, a 5xx the engine keeps retrying) is an error,
 * which counts as a failure, so a change that breaks every request can't pass as "nothing measured".
 */
function quotaStop(marks) {
  const r = marks.retry
  if (!r) return null
  if (QUOTA.test(r.message)) return `quota: ${r.message}`.slice(0, 300)
  if ((r.attempt ?? 1) >= 2) return `retrying: ${r.message || "the engine is retrying"}`.slice(0, 300)
  return null
}

function copyDir(from, to, skip = new Set()) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(e.name)) continue
    const a = path.join(from, e.name)
    const b = path.join(to, e.name)
    if (e.isDirectory()) {
      fs.mkdirSync(b, { recursive: true })
      copyDir(a, b)
    } else fs.copyFileSync(a, b)
  }
}

function setCassette(kase) {
  const src = kase.cassette ? fs.readFileSync(path.join(FIXTURES, kase.cassette), "utf8") : JSON.stringify({ format: "syrup.cassette", version: 1, entries: [] })
  fs.writeFileSync(cassetteFile, src)
  // The plugin re-reads the cassette when its mtime changes; two writes in one millisecond must still differ.
  const t = new Date(Date.now() + Math.floor(Math.random() * 1000))
  fs.utimesSync(cassetteFile, t, t)
}

function importSeed(kase, ws, projectID) {
  const parsed = L.parseTranscript(fs.readFileSync(path.join(FIXTURES, kase.seed.transcript), "utf8"))
  const seed = buildSeed(parsed, { turns: kase.seed.turns, directory: ws, projectID })
  const file = path.join(runDir, `${kase.id}-seed.json`)
  fs.writeFileSync(file, JSON.stringify(seed.data))
  const win = process.platform === "win32"
  const r = spawnSync(win ? `opencode import "${file}"` : "opencode", win ? [] : ["import", file], { cwd: ws, env: engineEnv, encoding: "utf8", shell: win, timeout: 60_000, windowsHide: true })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  if (r.status !== 0 || !out.includes(seed.sessionID)) throw new Error(`opencode import failed (exit ${r.status}): ${out.trim().slice(-400)}`)
  return seed
}

async function runTrial(host, kase, n) {
  const ws = path.join(wsRoot, `${kase.id}-${n}`)
  fs.mkdirSync(ws, { recursive: true })
  spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: ws })
  const seedDir = kase.workspace ? path.join(FIXTURES, kase.workspace) : null
  if (seedDir) copyDir(seedDir, ws, new Set(["hidden"]))
  setCassette(kase)
  const d = driver({ base: host.base, dir: ws })
  const trial = { n, status: "error", reason: null, checks: [], ttftMs: null, totalMs: null, models: [], inputTokensLast: null, requests: 0, replay: { hit: 0, fuzzy: 0, fallback: 0, miss: 0 } }
  let sessionID
  try {
    if (kase.seed) {
      const project = await d.oc("project/current").then((r) => (r.ok ? r.json() : null)).catch(() => null)
      sessionID = importSeed(kase, ws, project?.id ?? "global").sessionID
    } else sessionID = (await d.createSession()).id
  } catch (err) {
    trial.reason = `setup: ${err.message}`
    return trial
  }
  trial.session = sessionID
  const t0 = Date.now()
  const marks = []
  for (const text of kase.turns) {
    const m = await d.runTurn(sessionID, text, { model: MODEL, timeoutMs: TURN_TIMEOUT, abortOnTimeout: true, stopOn: quotaStop })
    marks.push(m)
    if (m.error || m.stopped || m.timedOut) break
  }
  const first = marks[0]
  const lastMark = marks.at(-1)
  trial.ttftMs = ms(first.sent, first.firstText)
  trial.totalMs = ms(first.sent, lastMark.idle)
  const answers = realAnswers(await d.answers(sessionID)).filter((a) => a.ts >= t0)
  trial.requests = answers.length
  trial.models = [...new Set(answers.map((a) => `${a.providerId}/${a.modelId}`))]
  trial.inputTokensLast = answers.length ? Math.max(...answers.map((a) => a.inputTokens ?? 0)) : null

  // The replay's own record of every web call this turn made (tool metadata in the engine's messages).
  const raw = await d.messages(sessionID).catch(() => [])
  for (const m of raw) {
    if ((m.info?.time?.created ?? 0) < t0 - 5_000) continue
    for (const p of m.parts ?? []) {
      if (p.type !== "tool" || !["websearch", "webfetch"].includes(p.tool)) continue
      const mode = p.state?.metadata?.replay?.mode ?? (p.state?.status === "error" ? "miss" : null)
      if (mode && mode in trial.replay) trial.replay[mode]++
    }
  }

  // The chat as syrup exports it, redacted: what the checks read and what a person reads afterwards.
  let parsed
  try {
    const res = await fetch(`${host.base}/api/eval/transcript?session=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(ws)}`)
    const json = await res.text()
    if (!res.ok) throw new Error(json.slice(0, 300))
    trial.transcript = `${kase.id}-${n}.json`
    fs.writeFileSync(path.join(runDir, trial.transcript), json)
    parsed = L.parseTranscript(json)
  } catch (err) {
    trial.reason = `export: ${err.message}`
    return trial
  }

  const errText = marks.map((m) => m.error).filter(Boolean).join("; ")
  const stopped = marks.find((m) => m.stopped)?.stopped
  if (stopped?.startsWith("quota:") || (!stopped && errText && QUOTA.test(errText))) {
    trial.status = "skipped"
    trial.reason = stopped ?? `quota: ${errText}`.slice(0, 300)
    return trial
  }
  if (stopped) {
    trial.status = "error"
    trial.reason = stopped
    return trial
  }
  if (lastMark.timedOut) {
    trial.reason = `no answer within ${TURN_TIMEOUT / 1000}s`
    return trial
  }
  const web = Object.values(trial.replay).reduce((a, b) => a + b, 0)
  if (kase.cassette && web > 0 && trial.replay.miss / web > 0.3) {
    trial.status = "off-script"
    trial.reason = `${trial.replay.miss} of ${web} web calls missed the cassette`
    return trial
  }

  const live = parsed.messages.filter((m) => !m.at || Date.parse(m.at) >= t0 - 5_000)
  const liveIdx = new Set(live.map((m) => m.index))
  const report = L.checkTranscript(parsed, { contextBudget: BUDGET })
    .reports.filter((r) => liveIdx.has(r.index))
    .flatMap((r) => r.findings)
  const ctx = {
    live,
    report,
    answers,
    workspace: ws,
    seedDir,
    runTests(cmd, timeoutMs) {
      const hidden = path.join(seedDir, "hidden")
      if (fs.existsSync(hidden)) copyDir(hidden, ws)
      return runIn(ws, cmd, timeoutMs)
    },
  }
  for (const check of kase.checks) {
    let r
    try {
      r = check.run(ctx)
    } catch (err) {
      r = { pass: false, detail: `check crashed: ${err.message}` }
    }
    trial.checks.push({ name: check.name, column: check.column, info: check.info, gap: check.gap, pass: r.pass, detail: r.detail })
  }
  if (errText) trial.checks.push({ name: "error", column: "done", pass: false, detail: errText.slice(0, 300) })
  trial.status = trial.checks.some((c) => c.pass === false && !c.info && !c.gap) ? "fail" : "pass"
  return trial
}

// ---------------------------------------------------------------- the run

const commit = (() => {
  const h = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim()
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout.trim()
  return `${h}${dirty ? "+dirty" : ""}`
})()

console.log(`syrup eval · ${SET} · ${cases.length} case(s) · starting an isolated syrup (ports ${hostPort}/${routerPort}/${enginePort}) …`)
let host
try {
  host = await startHost()
} catch (err) {
  console.error(String(err.message ?? err))
  process.exit(2)
}
console.log(`ready in ${(host.ms / 1000).toFixed(1)}s\n`)
const stop = () => {
  if (!flag("--keep")) killTree(host.child)
}
process.on("SIGINT", () => {
  stop()
  process.exit(130)
})

const run = { format: "syrup.eval", version: 1, set: SET, startedAt: Date.now(), commit, model: MODEL_ARG ?? "syrup/auto", dir: runDir, cases: [] }
const base = loadBaseline()
try {
  for (const kase of cases) {
    const c = { id: kase.id, title: kase.title, tags: kase.tags, trials: [] }
    const trialsWanted = TRIALS
    for (let n = 1; n <= trialsWanted; n++) {
      process.stdout.write(`${kase.id.padEnd(20)} trial ${n} … `)
      const t = await runTrial(host, kase, n)
      c.trials.push(t)
      console.log(`${t.status}${t.reason ? ` (${t.reason.slice(0, 160)})` : ""} · first text ${t.ttftMs ?? "–"} ms · ${t.models.join(", ") || "no model"} · ${t.inputTokensLast ?? "–"} input tokens`)
    }
    // Tier 1's sequential rule: a single failing trial gets two more before it counts.
    if (TRIALS === 1 && !flag("--no-rerun") && ["fail", "error"].includes(c.trials[0].status)) {
      for (let n = 2; n <= 3; n++) {
        process.stdout.write(`${kase.id.padEnd(20)} trial ${n} (re-run) … `)
        const t = await runTrial(host, kase, n)
        c.trials.push(t)
        console.log(`${t.status}${t.reason ? ` (${t.reason.slice(0, 160)})` : ""} · first text ${t.ttftMs ?? "–"} ms · ${t.models.join(", ") || "no model"}`)
      }
    }
    const cnt = counted(c)
    const failed = cnt.filter((t) => t.status !== "pass").length
    // One trial: its verdict. Re-run (Tier 1): FAIL when 2 of 3 fail (or the only counted trial did). --trials N: pass^N.
    const reran = TRIALS === 1 && c.trials.length > 1
    if (!cnt.length) c.result = c.trials.some((t) => t.status === "off-script") ? "OFF" : "SKIP"
    else if (reran) c.result = failed >= 2 || (cnt.length === 1 && failed === 1) ? "FAIL" : "PASS"
    else c.result = failed ? "FAIL" : "PASS"
    // Known gaps: each must still fail; one that passes is closed.
    const gapNames = [...new Set(kase.checks.filter((k) => k.gap).map((k) => k.name))]
    c.gaps = gapNames.map((name) => {
      const rs = cnt.map((t) => t.checks.find((x) => x.name === name)).filter((x) => x && x.pass !== null)
      const closed = rs.length > 0 && rs.some((x) => x.pass)
      return { name, status: closed ? "closed" : "open", detail: rs.map((x) => x.detail).join("; ") || "not measured", why: kase.checks.find((k) => k.name === name).gap }
    })
    run.cases.push(c)
  }
} finally {
  stop()
}
run.finishedAt = Date.now()
const reps = { hit: 0, fuzzy: 0, fallback: 0, miss: 0 }
for (const c of run.cases) for (const t of c.trials) for (const k of Object.keys(reps)) reps[k] += t.replay[k]
run.totals = {
  requests: run.cases.reduce((n, c) => n + c.trials.reduce((m, t) => m + t.requests, 0), 0),
  replay: reps,
  offScript: run.cases.reduce((n, c) => n + c.trials.filter((t) => t.status === "off-script").length, 0),
  skipped: run.cases.reduce((n, c) => n + c.trials.filter((t) => t.status === "skipped").length, 0),
  wallMs: run.finishedAt - run.startedAt,
}
run.regressions = run.cases.filter((c) => c.result === "FAIL" && base?.cases?.[c.id]?.result === "PASS").map((c) => c.id)
run.gapsClosed = run.cases.flatMap((c) => c.gaps.filter((g) => g.status === "closed").map((g) => `${c.id} · ${g.name}`))
fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(run, null, 2))
console.log(`\n${formatRun(run, base).join("\n")}`)
if (flag("--update-baseline")) {
  writeBaseline(run, base)
  console.log(`\nBaseline updated: ${path.relative(ROOT, path.join(ROOT, "scripts", "fixtures", "eval-baseline.json"))}. Say why in the commit.`)
}
if (flag("--keep")) console.log(`\nThe eval's syrup is still running at ${host.base} (pid ${host.child.pid}). Stop it with: taskkill /pid ${host.child.pid} /T /F`)
fs.rmSync(wsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
// 1: a regression or a closed gap to read; 3: nothing was measured (every trial skipped or off-script), so the run proves nothing.
const measured = run.cases.some((c) => c.trials.some((t) => t.status !== "skipped" && t.status !== "off-script"))
process.exit(run.regressions.length || run.gapsClosed.length ? 1 : measured ? 0 : 3)
