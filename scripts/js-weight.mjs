#!/usr/bin/env node
/**
 * Initial-JavaScript probe for the per-round rule "nothing new in the main chunk"
 * (docs/ROADMAP.md §2, docs/TESTING.md). Builds the app for production, starts it on
 * a free port next to the dev server, opens "/" and a chat with the UI harness's
 * fixture engine (scripts/ui-harness.mjs), and records every script the page loads:
 * bytes on the wire, decoded bytes, gzip bytes and the chunk list.
 *
 *   pnpm ui:weight                   # build, measure, print
 *   pnpm ui:weight --compare         # …and fail on growth against scripts/fixtures/js-weight-baseline.json
 *   pnpm ui:weight --update          # …and write that baseline (after a deliberate change)
 *   pnpm ui:weight --no-build        # measure the build already in .next
 *
 * "Initial" is what the server-rendered HTML declares (<script src>, script preloads):
 * the main chunk and the route's own chunks, loaded on every visit. Chunks loaded after
 * hydration (first use, idle prefetch) are listed as "after load" and never fail the
 * check, because the roadmap allows them. --compare fails when initial JS grows by more
 * than 2 KB gzipped on any route, or a new chunk joins the initial load. Chunk files are
 * content-hashed, so a chunk is matched across builds by the Turbopack module ids inside
 * it (deterministic in production builds), not by its name.
 *
 * Next.js 16 builds into .next while `next dev` uses .next/dev, so both can run in one
 * folder (node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md, "Concurrent
 * dev and build"); `next build` never runs instrumentation, and the dev server is never
 * touched. The production server gets its own database, config folder and router port
 * (node_modules/.cache/syrup-js-weight), no provider keys from the environment, and
 * OPENCODE_URL pointing at the dev server's engine, so it attaches instead of spawning a
 * second engine on port 4096. Attach mode can't authenticate there (the engine password is
 * a per-process secret, src/server/env.ts), which doesn't matter: the browser's engine is
 * the fixture. The server is stopped when the probe ends.
 *
 * Flags: --compare · --update · --no-build · --scenarios <a,b> (default new-chat,chat-markdown)
 * · --baseline <file> (default scripts/fixtures/js-weight-baseline.json) · --engine <url> (default
 * http://127.0.0.1:4096) · --keep (leave the server running, print its URL)
 */
import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import vm from "node:vm"
import { gzipSync } from "node:zlib"
import { chromium } from "playwright"
import { deviceFor, installFakeEngine, loadScenarios, ROOT, startEventServer, waitForStable, waitUntilReady } from "./ui-harness.mjs"

const BASELINE = path.join(ROOT, "scripts", "fixtures", "js-weight-baseline.json")
const CACHE = path.join(ROOT, "node_modules", ".cache", "syrup-js-weight")
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next")
const LIMIT_GZIP = 2048

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const args = argv.filter((a) => a !== "--")
  const o = { compare: false, update: false, build: true, scenarios: ["new-chat", "chat-markdown"], engine: "http://127.0.0.1:4096", keep: false, baseline: BASELINE }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--compare") o.compare = true
    else if (a === "--update") o.update = true
    else if (a === "--no-build") o.build = false
    else if (a === "--keep") o.keep = true
    else if (a === "--scenarios") o.scenarios = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--engine") o.engine = args[++i] ?? o.engine
    else if (a === "--baseline") o.baseline = path.resolve(args[++i] ?? BASELINE)
    else throw new Error(`Unknown argument ${a}. See the comment at the top of scripts/js-weight.mjs.`)
  }
  return o
}

// ---------------------------------------------------------------- processes

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** The production server's environment: isolated state, no provider keys, no second engine. */
function serverEnv(routerPort, engineUrl) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/_(API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/i.test(k)) delete env[k]
  mkdirSync(path.join(CACHE, "home"), { recursive: true })
  return {
    ...env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    SYRUP_MODE: "local",
    OPENCODE_URL: engineUrl,
    SYRUP_ROUTER_PORT: String(routerPort),
    SYRUP_DB: `file:${path.join(CACHE, "data", "syrup.db")}`,
    SYRUP_HOME: path.join(CACHE, "home"),
  }
}

/** Runs `next build` into .next (the dev server lives in .next/dev). next-env.d.ts is put back as it was. */
function build(env) {
  const envFile = path.join(ROOT, "next-env.d.ts")
  const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : null
  const t0 = Date.now()
  console.log("Building for production (next build → .next; the dev server keeps .next/dev)…")
  const r = spawnSync(process.execPath, [NEXT_BIN, "build"], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
  writeFileSync(path.join(CACHE, "build.log"), log)
  if (before !== null && readFileSync(envFile, "utf8") !== before) writeFileSync(envFile, before)
  if (r.status !== 0) {
    console.error(log.trim().split("\n").slice(-40).join("\n"))
    throw new Error(`next build failed (exit ${r.status}); full log in ${path.relative(ROOT, path.join(CACHE, "build.log"))}`)
  }
  console.log(`Built in ${((Date.now() - t0) / 1000).toFixed(0)} s.`)
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  else {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
  }
}

/** `next start` on its own (output to server.log, own process group), so --keep can leave it running after the probe exits. */
async function startServer(port, env) {
  const logFile = path.join(CACHE, "server.log")
  const fd = openSync(logFile, "w")
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: ROOT, env, stdio: ["ignore", fd, fd], detached: true, windowsHide: true })
  closeSync(fd)
  const tail = () => readFileSync(logFile, "utf8").slice(-2000)
  const base = `http://127.0.0.1:${port}`
  const t0 = Date.now()
  while (Date.now() - t0 < 90_000) {
    if (child.exitCode !== null) throw new Error(`next start exited (${child.exitCode}):\n${tail()}`)
    const ok = await fetch(`${base}/api/health`)
      .then((r) => r.ok)
      .catch(() => false)
    if (ok) return { child, base }
    await new Promise((r) => setTimeout(r, 500))
  }
  killTree(child)
  throw new Error(`next start did not answer on ${base} within 90 s:\n${tail()}`)
}

// ---------------------------------------------------------------- chunks

/**
 * The Turbopack module ids a chunk defines. A chunk is `TURBOPACK.push([script, id…, factory, id…, factory…])`
 * (one or more ids per factory); running it in an empty context only defines the factories, nothing
 * executes, so the ids are exact.
 */
function chunkModules(code) {
  const ctx = vm.createContext({ TURBOPACK: [] })
  try {
    vm.runInContext(code, ctx, { timeout: 2000 })
  } catch {
    // The runtime chunk goes on to boot itself and fails without a DOM; its first push is still recorded.
  }
  const ids = []
  const list = Array.isArray(ctx.TURBOPACK) ? ctx.TURBOPACK : []
  for (const entry of list) {
    if (!Array.isArray(entry)) continue
    let pending = []
    for (const x of entry.slice(1)) {
      if (typeof x === "number") pending.push(x)
      else if (typeof x === "function") {
        ids.push(...pending)
        pending = []
      } else pending = []
    }
  }
  return [...new Set(ids)].sort((a, b) => a - b)
}

/** Script URLs the server-rendered HTML declares: <script src> (not the nomodule polyfills modern browsers skip) and script preloads. */
function declaredScripts(html, base) {
  const out = new Set()
  for (const m of html.matchAll(/<script\b[^>]*>/g)) {
    const src = m[0].match(/\bsrc="([^"]+)"/)
    if (src && !/\bnomodule\b/i.test(m[0])) out.add(new URL(src[1].replace(/&amp;/g, "&"), base).pathname)
  }
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0]
    if (!/\brel="(preload|modulepreload)"/.test(tag) || (/\brel="preload"/.test(tag) && !/\bas="script"/.test(tag))) continue
    const href = tag.match(/\bhref="([^"]+)"/)
    if (href) out.add(new URL(href[1].replace(/&amp;/g, "&"), base).pathname)
  }
  return out
}

const sum = (list, k) => list.reduce((n, c) => n + c[k], 0)
const kb = (n) => `${(n / 1024).toFixed(1)} KB`

async function measure(browser, scenario, base, events, mainFiles) {
  const context = await browser.newContext({ ...deviceFor(1440), locale: "en-US", timezoneId: "UTC", serviceWorkers: "block" })
  const channel = `weight-${scenario.name}-${Math.random().toString(36).slice(2, 7)}`
  const errors = []
  try {
    const handle = await installFakeEngine(context, scenario, { base, events, channel })
    const page = await context.newPage()
    // From Playwright's network events, not the page's Resource Timing: the fixtures' frozen clock
    // (page.clock.setFixedTime) replaces performance.getEntries* with stubs that return nothing.
    const origin = new URL(base).origin
    const t0 = Date.now()
    let lastScriptAt = Date.now()
    const loads = new Map()
    const pending = []
    page.on("request", (req) => {
      if (req.resourceType() === "script") lastScriptAt = Date.now()
    })
    page.on("requestfinished", (req) => {
      const url = new URL(req.url())
      if (req.resourceType() !== "script" || url.origin !== origin || loads.has(url.pathname)) return
      const at = Date.now() - t0
      loads.set(url.pathname, null)
      pending.push(
        (async () => {
          const res = await req.response()
          const [body, sizes] = await Promise.all([res.body(), req.sizes()])
          loads.set(url.pathname, { file: url.pathname, at, encoded: sizes.responseBodySize, body })
        })().catch((e) => errors.push(`could not read ${url.pathname}: ${e.message}`)),
      )
    })
    page.on("pageerror", (e) => errors.push(e.message))
    const resp = await page.goto(base + scenario.route, { waitUntil: "load", timeout: 90_000 })
    const html = (await resp?.text()) ?? ""
    await waitUntilReady(page, scenario)
    await waitForStable(page)
    // Idle: no new script request for two seconds (on-demand and idle-prefetched chunks land in that window).
    while (Date.now() - lastScriptAt < 2_000 && Date.now() - t0 < 30_000) await page.waitForTimeout(200)
    await Promise.all(pending)
    if (handle.log.unmocked.length) errors.push(`unmocked: ${handle.log.unmocked.join(", ")}`)
    const declared = declaredScripts(html, base)
    const chunks = [...loads.values()]
      .filter(Boolean)
      .map((l) => ({
        file: l.file,
        initial: declared.has(l.file),
        main: mainFiles.has(l.file),
        at: l.at,
        encoded: l.encoded,
        decoded: l.body.length,
        gzip: gzipSync(l.body).length,
        modules: chunkModules(l.body.toString("utf8")),
      }))
      .sort((a, b) => a.at - b.at)
    const initial = chunks.filter((c) => c.initial)
    const later = chunks.filter((c) => !c.initial)
    const missing = [...declared].filter((f) => /\.js$/.test(f) && !chunks.some((c) => c.file === f))
    return {
      scenario: scenario.name,
      route: scenario.route,
      initial: { count: initial.length, encoded: sum(initial, "encoded"), decoded: sum(initial, "decoded"), gzip: sum(initial, "gzip"), main: { count: initial.filter((c) => c.main).length, gzip: sum(initial.filter((c) => c.main), "gzip") }, chunks: initial.map(({ file, main, encoded, decoded, gzip, modules }) => ({ file, main, encoded, decoded, gzip, modules })) },
      afterLoad: { count: later.length, gzip: sum(later, "gzip"), chunks: later.map(({ file, at, gzip, modules }) => ({ file, at, gzip, modules })) },
      notLoaded: missing,
      errors,
    }
  } finally {
    await context.close().catch(() => {})
    events.drop(channel)
  }
}

// ---------------------------------------------------------------- compare

/** A chunk's name without its 13-character content hash: "turbopack" for turbopack-2zd2yis61eamr.js, "" for 0-fbgp0jirfhe.js. */
const namePrefix = (f) => path.basename(f).match(/^(.*?)-?[0-9a-z_-]{13}\.js$/i)?.[1] ?? ""

/** Same chunk across builds: same file, or most of the smaller one's modules in common, or the same named prefix (turbopack-…). */
function sameChunk(a, b) {
  if (a.file === b.file) return true
  if (a.modules.length && b.modules.length) {
    const set = new Set(b.modules)
    const common = a.modules.filter((m) => set.has(m)).length
    return common / Math.min(a.modules.length, b.modules.length) >= 0.5
  }
  return !!namePrefix(a.file) && namePrefix(a.file) === namePrefix(b.file)
}

function compare(current, baseline) {
  const lines = []
  let failed = false
  for (const r of current.routes) {
    const b = baseline.routes.find((x) => x.scenario === r.scenario)
    if (!b) {
      lines.push(`  ${r.scenario}: not in the baseline (run --update once to record it)`)
      continue
    }
    const growth = r.initial.gzip - b.initial.gzip
    const fresh = r.initial.chunks.filter((c) => !b.initial.chunks.some((x) => sameChunk(c, x)))
    const gone = b.initial.chunks.filter((x) => !r.initial.chunks.some((c) => sameChunk(c, x)))
    const tooBig = growth > LIMIT_GZIP
    if (tooBig || fresh.length) failed = true
    const sign = growth >= 0 ? "+" : "−"
    lines.push(`  ${tooBig || fresh.length ? "✗" : "✓"} ${r.scenario} (${r.route}): initial JS ${sign}${kb(Math.abs(growth))} gzip (${kb(b.initial.gzip)} → ${kb(r.initial.gzip)}, limit +${kb(LIMIT_GZIP)}), ${r.initial.count} chunks (was ${b.initial.count})`)
    for (const c of fresh) lines.push(`      new initial chunk ${c.file}: ${kb(c.gzip)} gzip, ${c.modules.length} modules`)
    for (const c of gone) lines.push(`      no longer initial: ${c.file} (${kb(c.gzip)} gzip)`)
    const allNew = r.initial.chunks.length > 1 && fresh.length === r.initial.chunks.length
    if (allNew) lines.push("      every chunk looks new: Turbopack may have renumbered its module ids; judge by the gzip figure, then re-baseline with --update")
    const lazyNew = r.afterLoad.chunks.filter((c) => !b.afterLoad.chunks.some((x) => sameChunk(c, x)))
    if (lazyNew.length) lines.push(`      after load (allowed, for review): ${lazyNew.length} chunk(s) not in the baseline, ${kb(sum(lazyNew, "gzip"))} gzip`)
  }
  return { failed, lines }
}

// ---------------------------------------------------------------- main

function printRoutes(routes) {
  for (const r of routes) {
    console.log(`\n${r.scenario}  ${r.route}`)
    console.log(`  initial JS   ${r.initial.count} chunks · ${kb(r.initial.decoded)} · ${kb(r.initial.gzip)} gzip · ${kb(r.initial.encoded)} on the wire  (main chunk: ${r.initial.main.count} files, ${kb(r.initial.main.gzip)} gzip)`)
    for (const c of r.initial.chunks) console.log(`    ${c.main ? "main " : "route"}  ${c.file.padEnd(44)} ${kb(c.gzip).padStart(9)} gzip  ${String(c.modules.length).padStart(4)} modules`)
    console.log(`  after load   ${r.afterLoad.count} chunks · ${kb(r.afterLoad.gzip)} gzip`)
    for (const c of r.afterLoad.chunks) console.log(`    later  ${c.file.padEnd(44)} ${kb(c.gzip).padStart(9)} gzip  ${String(c.modules.length).padStart(4)} modules  at ${c.at} ms`)
    if (r.notLoaded.length) console.log(`  declared but not loaded: ${r.notLoaded.join(", ")}`)
    if (r.errors.length) console.log(`  page errors: ${r.errors.join(" | ")}`)
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const scenarios = await loadScenarios(o.scenarios)
  mkdirSync(path.join(CACHE, "data"), { recursive: true })
  const [port, routerPort] = [await freePort(), await freePort()]
  const env = serverEnv(routerPort, o.engine)
  if (o.build) build(env)
  else if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) throw new Error("No production build in .next; run without --no-build")
  const buildId = readFileSync(path.join(ROOT, ".next", "BUILD_ID"), "utf8").trim()
  const manifest = JSON.parse(readFileSync(path.join(ROOT, ".next", "build-manifest.json"), "utf8"))
  const mainFiles = new Set((manifest.rootMainFiles ?? []).map((f) => `/_next/${f}`))

  const server = await startServer(port, env)
  console.log(`Production server on ${server.base} (router port ${routerPort}, engine ${o.engine}, state in ${path.relative(ROOT, CACHE)})`)
  const stop = () => killTree(server.child)
  process.on("SIGINT", () => {
    stop()
    process.exit(130)
  })
  const routes = []
  let events = null
  let browser = null
  try {
    events = await startEventServer()
    browser = await chromium.launch()
    for (const s of scenarios) routes.push(await measure(browser, s, server.base, events, mainFiles))
  } finally {
    await browser?.close()
    events?.close()
    if (!o.keep) stop()
    else {
      server.child.unref()
      const how = process.platform === "win32" ? `taskkill /pid ${server.child.pid} /T /F` : `kill -- -${server.child.pid}`
      console.log(`--keep: the production server is still running on ${server.base}; stop it with: ${how}`)
    }
  }

  const next = JSON.parse(readFileSync(path.join(ROOT, "node_modules", "next", "package.json"), "utf8")).version
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim() || null
  const report = {
    version: 1,
    note: "Initial JavaScript per route on a production build, engine faked by the UI harness fixtures. Written by scripts/js-weight.mjs --update; checked by --compare (docs/TESTING.md).",
    measuredAt: new Date().toISOString(),
    next,
    commit,
    buildId,
    limitGzipBytes: LIMIT_GZIP,
    routes,
  }
  printRoutes(routes)
  // Without load times (they vary run to run), so the committed baseline only changes when the bundle does;
  // module-id lists on one line each, so a diff shows which chunk changed rather than hundreds of numbers.
  const saved = `${JSON.stringify(report, (k, v) => (k === "at" ? undefined : v), 2).replace(/\[\s+((?:\d+,\s+)*\d+)\s+\]/g, (_, ids) => `[${ids.replace(/,\s+/g, ", ")}]`)}\n`
  writeFileSync(path.join(CACHE, "latest.json"), saved)
  if (routes.some((r) => r.errors.length)) {
    console.error("\nThe page had errors while measuring; fix them before trusting these numbers.")
    return 1
  }
  if (o.update) {
    writeFileSync(o.baseline, saved)
    console.log(`\nBaseline written: ${path.relative(ROOT, o.baseline)}`)
  }
  if (o.compare) {
    if (!existsSync(o.baseline)) throw new Error(`No baseline at ${path.relative(ROOT, o.baseline)}; run pnpm ui:weight --update first`)
    const baseline = JSON.parse(readFileSync(o.baseline, "utf8"))
    const { failed, lines } = compare(report, baseline)
    console.log(`\nAgainst the baseline (${baseline.measuredAt.slice(0, 10)}, ${baseline.commit ?? "unknown commit"}):`)
    for (const l of lines) console.log(l)
    if (failed) {
      console.log("\nInitial JavaScript grew. Move the new code behind next/dynamic (loaded on first use), or, if the growth is deliberate, re-baseline with pnpm ui:weight --update and say why in the commit.")
      return 1
    }
    console.log("\nNothing new in the initial load.")
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
