#!/usr/bin/env node
/**
 * Tests syrup's OpenCode plugin (src/server/engine/syrup-plugin.ts) and the config-dir
 * preparation that makes loading it free (src/server/engine/config-dirs.ts, docs/QUALITY.md Q0).
 * No engine, no network, a few temporary folders. Under two seconds.
 *
 *   pnpm test:plugin
 *
 * - config dirs: the rule (decide), the files a prepared dir gets, what is never touched (a dir with
 *   node_modules, a package.json, the user's plugins or tools, a config naming plugins, a missing
 *   ~/.opencode), how local dirs are resolved (XDG_CONFIG_HOME, OPENCODE_TEST_HOME,
 *   OPENCODE_CONFIG_DIR), and the sandbox's CLI build doing the same on disk.
 * - plugin: one export; no hooks at all while SYRUP_EVAL_REPLAY is unset; with it, websearch and
 *   webfetch answer from the cassette (hit, fuzzy, fallback, miss), validate their arguments, follow
 *   a swapped cassette, and get OpenCode 1.18.32's own definitions (scripts/fixtures/eval/opencode-web-tools.json).
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT = path.join(ROOT, "node_modules", ".cache", "syrup-plugin-test")
fs.mkdirSync(OUT, { recursive: true })

async function bundle(entry, name) {
  const outfile = path.join(OUT, `${name}.mjs`)
  await build({ entryPoints: [path.join(ROOT, entry)], outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" })
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
}

const results = []
async function test(name, fn) {
  try {
    await fn()
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
async function rejects(p, re, msg) {
  try {
    await p
  } catch (err) {
    if (re.test(String(err?.message ?? err))) return
    throw new Error(`${msg}: wrong error ${err?.message ?? err}`)
  }
  throw new Error(`${msg}: did not throw`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syrup-plugin-test-"))
const mk = (...p) => {
  const d = path.join(tmp, ...p)
  fs.mkdirSync(d, { recursive: true })
  return d
}

// ---------------------------------------------------------------- config dirs

const C = await bundle("src/server/engine/config-dirs.ts", "config-dirs")
const S = (entries = [], userCode = []) => ({ exists: true, entries, userCode })

await test("config dirs: the rule", () => {
  eq(C.decide(S([]), { create: false }), { action: "prepare", reason: "prepared" }, "an empty dir is prepared")
  eq(C.decide(S(["skills", "opencode.jsonc"]), { create: false }), { action: "prepare", reason: "prepared" }, "skills and a config without plugins don't count")
  eq(C.decide(S(["node_modules"]), { create: true }), { action: "skip", reason: "has-node-modules" }, "node_modules: already installed or prepared")
  eq(C.decide(S(["package.json"]), { create: true }), { action: "skip", reason: "has-package-json" }, "package.json: the user's or OpenCode's own")
  eq(C.decide(S(["plugin"], ["plugin/mine.ts"]), { create: true }), { action: "skip", reason: "user-code" }, "the user's plugin needs the real install")
  eq(C.decide({ exists: false, entries: [], userCode: [] }, { create: true }), { action: "prepare", reason: "prepared" }, "a missing XDG dir is created")
  eq(C.decide({ exists: false, entries: [], userCode: [] }, { create: false }), { action: "skip", reason: "missing" }, "a missing ~/.opencode stays missing")
})

await test("config dirs: what a prepared dir holds", () => {
  const xdg = path.join(tmp, "a", "xdg", "opencode")
  const r = C.prepareConfigDirs([{ dir: xdg, create: true }])
  eq(r.map((x) => x.reason), ["prepared"], "prepared")
  eq(fs.readdirSync(xdg).sort(), ["node_modules", "package-lock.json", "package.json"], "three entries")
  eq(fs.readdirSync(path.join(xdg, "node_modules")), [], "node_modules is empty")
  eq(JSON.parse(fs.readFileSync(path.join(xdg, "package.json"), "utf8")), { dependencies: { "@opencode-ai/plugin": "1.18.32" } }, "package.json names the pinned plugin package")
  eq(JSON.parse(fs.readFileSync(path.join(xdg, "package-lock.json"), "utf8")), { lockfileVersion: 3, requires: true, packages: { "": { dependencies: { "@opencode-ai/plugin": "1.18.32" } } } }, "the lock too")
  eq(C.prepareConfigDirs([{ dir: xdg, create: true }]).map((x) => x.reason), ["has-node-modules"], "a second start changes nothing")
})

await test("config dirs: what is never touched", () => {
  const withModules = mk("b", "modules")
  fs.mkdirSync(path.join(withModules, "node_modules", "@opencode-ai"), { recursive: true })
  const withPkg = mk("b", "pkg")
  fs.writeFileSync(path.join(withPkg, "package.json"), '{"dependencies":{"left-pad":"1.0.0"}}')
  const withPlugin = mk("b", "plugins", "plugins")
  fs.writeFileSync(path.join(withPlugin, "notify.js"), "export const N = async () => ({})")
  const withTool = mk("b", "tools", "tool")
  fs.writeFileSync(path.join(withTool, "deploy.ts"), "export default {}")
  const withConfig = mk("b", "config")
  fs.writeFileSync(path.join(withConfig, "opencode.jsonc"), '{\n  // mine\n  "plugin": ["opencode-wakatime"]\n}')
  const notThere = path.join(tmp, "b", "home", ".opencode")
  const before = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : null)
  const dirs = [withModules, withPkg, path.dirname(withPlugin), path.dirname(withTool), withConfig, notThere]
  const snap = dirs.map(before)
  const r = C.prepareConfigDirs(dirs.map((dir, i) => ({ dir, create: i < 5 })).map((d, i) => (i === 5 ? { ...d, create: false } : d)))
  eq(r.map((x) => x.reason), ["has-node-modules", "has-package-json", "user-code", "user-code", "user-code", "missing"], "reasons")
  eq(dirs.map(before), snap, "nothing written anywhere")
  eq(fs.readFileSync(path.join(withPkg, "package.json"), "utf8"), '{"dependencies":{"left-pad":"1.0.0"}}', "the user's package.json is intact")
})

await test("config dirs: local resolution follows OpenCode 1.18.32", () => {
  const home = path.join(tmp, "home")
  eq(C.localConfigDirs({}, home), [{ dir: path.join(home, ".config", "opencode"), create: true }, { dir: path.join(home, ".opencode"), create: false }], "defaults: ~/.config/opencode (on Windows too) and ~/.opencode")
  const x = path.join(tmp, "xdg")
  const t = path.join(tmp, "testhome")
  const cd = path.join(tmp, "cfgdir")
  eq(
    C.localConfigDirs({ XDG_CONFIG_HOME: x, OPENCODE_TEST_HOME: t, OPENCODE_CONFIG_DIR: cd }, home),
    [{ dir: path.join(x, "opencode"), create: true }, { dir: path.join(t, ".opencode"), create: false }, { dir: path.resolve(cd), create: false }],
    "XDG_CONFIG_HOME, OPENCODE_TEST_HOME and OPENCODE_CONFIG_DIR",
  )
  eq(C.SANDBOX_CONFIG_DIRS, [{ dir: "/vercel/.config/opencode", create: true }, { dir: "/vercel/.opencode", create: false }], "sandbox dirs")
  const same = path.join(tmp, "dup")
  eq(C.prepareConfigDirs([{ dir: same, create: true }, { dir: same, create: true }]).length, 1, "a dir listed twice is handled once")
})

await test("config dirs: the sandbox's CLI build does the same on disk", () => {
  const cli = path.join(OUT, "prepare-config-dirs.mjs")
  const r0 = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild"), path.join(ROOT, "sidecar", "prepare-config-dirs.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${cli}`, "--log-level=warning"], { encoding: "utf8" })
  ok(r0.status === 0, `esbuild: ${r0.stderr}`)
  const xdg = path.join(tmp, "sb", ".config", "opencode")
  const installer = mk("sb", ".opencode", "bin")
  const r = spawnSync(process.execPath, [cli, "--create", xdg, "--existing", path.dirname(installer), "--existing", path.join(tmp, "sb", "nope")], { encoding: "utf8" })
  eq(r.status, 0, "exit 0")
  const out = JSON.parse(r.stdout.trim()).prepareConfigDirs
  eq(out.map((x) => x.reason), ["prepared", "prepared", "missing"], "both sandbox dirs prepared, a missing one skipped")
  ok(fs.existsSync(path.join(path.dirname(installer), "node_modules")) && fs.existsSync(path.join(path.dirname(installer), "bin")), "~/.opencode keeps its bin and gains node_modules")
})

// ---------------------------------------------------------------- plugin

const pluginFile = path.join(OUT, "syrup-plugin.mjs")
await build({ entryPoints: [path.join(ROOT, "src", "server", "engine", "syrup-plugin.ts")], outfile: pluginFile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" })
const P = await import(`${pathToFileURL(pluginFile).href}?t=${Date.now()}`)
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "eval", "opencode-web-tools.json"), "utf8"))

async function withEnv(vars, fn) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const cassetteFile = path.join(tmp, "cassette.json")
const writeCassette = (entries, mtime) => {
  fs.writeFileSync(cassetteFile, JSON.stringify({ format: "syrup.cassette", version: 1, entries }))
  if (mtime) fs.utimesSync(cassetteFile, mtime, mtime)
}
writeCassette([
  { tool: "websearch", key: "k2 expedition cost total price supported 2026", title: "Exa Web Search: K2 expedition cost total price supported 2026", output: "Title: K2 costs\nURL: https://example.org/k2\nHighlights:\nUSD 45,000" },
  { tool: "websearch", key: "usd to pkr exchange rate 2026", output: "Title: Rates\nURL: https://example.org/fx\n1 USD = 277 PKR" },
  { tool: "webfetch", key: "https://example.org/k2/costs", title: "https://example.org/k2/costs (text/html)", output: "# K2 costs\n| Item | USD |\n|---|---|\n| Permit | 5,000 |" },
])

await test("plugin: one export, and no hooks at all while SYRUP_EVAL_REPLAY is unset", async () => {
  eq(Object.keys(P), ["SyrupPlugin"], "OpenCode calls every exported function as a plugin")
  const hooks = await withEnv({ SYRUP_EVAL_REPLAY: undefined }, () => P.SyrupPlugin({}))
  eq(hooks, {}, "no tools, no hooks: the engine is exactly what it is without the plugin")
})

await test("plugin: replay tools carry OpenCode 1.18.32's own definitions", async () => {
  const hooks = await withEnv({ SYRUP_EVAL_REPLAY: cassetteFile }, () => P.SyrupPlugin({}))
  eq(Object.keys(hooks.tool).sort(), ["webfetch", "websearch"], "websearch and webfetch (1.18.32 has no codesearch)")
  const year = new Date().getFullYear()
  for (const want of FIXTURE.tools) {
    const out = { description: "plugin's own", parameters: {} }
    await hooks["tool.definition"]({ toolID: want.id }, out)
    const desc = want.description.replaceAll("2026", String(year)).replaceAll("2025", String(year - 1))
    eq(out.description, desc, `${want.id} description, word for word`)
    eq(out.jsonSchema, want.parameters, `${want.id} schema`)
    eq(hooks.tool[want.id].description, desc, `${want.id} registered with the same description`)
    eq(Object.keys(hooks.tool[want.id].args), Object.keys(want.parameters.properties), `${want.id} args keep every key`)
  }
  const glob = { description: "Fast file pattern matching", parameters: {} }
  await hooks["tool.definition"]({ toolID: "glob" }, glob)
  eq(glob, { description: "Fast file pattern matching", parameters: {} }, "other tools are left alone")
})

await test("plugin: websearch answers from the cassette (hit, fuzzy, fallback, miss)", async () => {
  const hooks = await withEnv({ SYRUP_EVAL_REPLAY: cassetteFile }, () => P.SyrupPlugin({}))
  const s = (args) => hooks.tool.websearch.execute(args, { sessionID: "ses_test" })
  const hit = await s({ query: "K2 expedition cost: total price (supported) 2026!" })
  eq(hit.metadata.replay.mode, "hit", "punctuation and case don't matter")
  eq(hit.title, "Exa Web Search: K2 expedition cost total price supported 2026", "the recorded title")
  ok(hit.output.includes("USD 45,000"), "the recorded output")
  const fuzzy = await s({ query: "USD to PKR rate 2026", numResults: 5 })
  eq([fuzzy.metadata.replay.mode, fuzzy.metadata.replay.matched], ["fuzzy", "usd to pkr exchange rate 2026"], "nearest query by word overlap")
  eq(fuzzy.title, "Exa Web Search: USD to PKR rate 2026", "a fuzzy answer is titled with the model's own query")
  const miss = await s({ query: "best pizza in lahore" })
  eq([miss.metadata.replay.mode, miss.output], ["miss", "No search results found. Please try a different query."], "OpenCode's own words on a miss")
  writeCassette([{ tool: "websearch", key: "*", output: "Title: Synthetic\nURL: https://example.org/s\nThe fee is USD 7,777." }], new Date(Date.now() + 5000))
  const fb = await s({ query: "anything at all" })
  eq([fb.metadata.replay.mode, fb.output.includes("7,777")], ["fallback", true], "a '*' entry answers every search (synthetic cassettes), and a swapped cassette is re-read")
})

await test("plugin: webfetch answers from the cassette; a page it doesn't have is a dead link", async () => {
  writeCassette([{ tool: "webfetch", key: "https://example.org/k2/costs", title: "https://example.org/k2/costs (text/html)", output: "# K2 costs" }], new Date(Date.now() + 10_000))
  const hooks = await withEnv({ SYRUP_EVAL_REPLAY: cassetteFile }, () => P.SyrupPlugin({}))
  const f = (args) => hooks.tool.webfetch.execute(args, { sessionID: "ses_test" })
  const r = await f({ url: "http://example.org/k2/costs/?utm_source=x#top", format: "markdown" })
  eq([r.metadata.replay.mode, r.output], ["hit", "# K2 costs"], "http, utm_*, fragment and trailing slash don't matter")
  await rejects(f({ url: "https://example.org/other" }), /status code: 404/, "a missing page")
  await rejects(f({ url: "ftp://example.org/x" }), /must start with http/, "a bad scheme")
})

await test("plugin: arguments are validated like a schema would", async () => {
  const hooks = await withEnv({ SYRUP_EVAL_REPLAY: cassetteFile }, () => P.SyrupPlugin({}))
  await rejects(hooks.tool.websearch.execute({}, { sessionID: "s" }), /invalid arguments: query: required/, "query is required")
  await rejects(hooks.tool.websearch.execute({ query: "x", numResults: "5" }, { sessionID: "s" }), /numResults: expected a number/, "types")
  await rejects(hooks.tool.websearch.execute({ query: "x", type: "slow" }, { sessionID: "s" }), /type: expected one of auto, fast, deep/, "enums")
  await rejects(hooks.tool.webfetch.execute({ url: "https://example.org", format: "pdf" }, { sessionID: "s" }), /format: expected one of text, markdown, html/, "webfetch enums")
})

await test("plugin: a missing cassette file means every lookup misses, never a crash", async () => {
  const hooks = await withEnv({ SYRUP_EVAL_REPLAY: path.join(tmp, "nope.json") }, () => P.SyrupPlugin({}))
  eq((await hooks.tool.websearch.execute({ query: "k2" }, { sessionID: "s" })).metadata.replay.mode, "miss", "miss")
})

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} tests passed`)
process.exit(failed ? 1 : 0)
