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
 * - plugin: one export; no hooks at all with both features off; with SYRUP_EVAL_REPLAY, websearch and
 *   webfetch answer from the cassette (hit, fuzzy, fallback, miss), validate their arguments, follow
 *   a swapped cassette, and get OpenCode 1.18.32's own definitions (scripts/fixtures/eval/opencode-web-tools.json).
 * - context hygiene (Q2): numResults, the websearch definition, the search trimmer on the six real
 *   K2 searches (scripts/fixtures/eval/transcripts/k2.md) and on adversarial inputs (a price table
 *   split across highlights, a huge table, malformed blocks, a huge single passage), the table rule,
 *   the webfetch cap, masking of earlier turns' web results, the in-turn budget, the compaction
 *   "continue" rule, and that coding tools are never touched.
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

await test("plugin: one export, and no hooks at all with both features off", async () => {
  eq(Object.keys(P), ["SyrupPlugin"], "OpenCode calls every exported function as a plugin")
  const hooks = await withEnv({ SYRUP_EVAL_REPLAY: undefined, SYRUP_CONTEXT_HYGIENE: "0" }, () => P.SyrupPlugin({}))
  eq(hooks, {}, "no tools, no hooks: the engine is exactly what it is without the plugin")
  const prod = await withEnv({ SYRUP_EVAL_REPLAY: undefined, SYRUP_CONTEXT_HYGIENE: undefined }, () => P.SyrupPlugin({}))
  eq(prod.tool, undefined, "production (hygiene on, no replay) registers no tool of its own: the built-ins run")
  eq(
    Object.keys(prod).sort(),
    ["event", "experimental.chat.messages.transform", "experimental.compaction.autocontinue", "tool.definition", "tool.execute.after", "tool.execute.before"],
    "the hygiene hooks",
  )
})

await test("plugin: replay tools carry OpenCode 1.18.32's own definitions", async () => {
  const hooks = await withEnv({ SYRUP_EVAL_REPLAY: cassetteFile, SYRUP_CONTEXT_HYGIENE: "0" }, () => P.SyrupPlugin({}))
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

// ---------------------------------------------------------------- context hygiene (Q2)

const H = await withEnv({ SYRUP_EVAL_REPLAY: undefined, SYRUP_CONTEXT_HYGIENE: undefined }, () => P.SyrupPlugin({}))
const after = async (tool, args, output) => {
  const o = { title: "t", output, metadata: { truncated: false } }
  await H["tool.execute.after"]({ tool, sessionID: "s", callID: "c", args }, o)
  return o
}

/** The six real searches of the incident chat, read from the committed export. */
const K2 = (() => {
  // A Windows checkout (core.autocrlf) gives the fixture CRLF line ends; the searches are matched on LF.
  const md = fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "eval", "transcripts", "k2.md"), "utf8").replace(/\r\n/g, "\n")
  const out = []
  for (const m of md.matchAll(/### Tool: websearch[^\n]*\n[\s\S]*?Input:\n\n```json\n([\s\S]*?)\n```\n\nOutput:\n\n```text\n([\s\S]*?)\n```\n/g)) out.push({ input: JSON.parse(m[1]), output: m[2] })
  return out
})()

const isTableLine = (l) => l.trim().startsWith("|") || (l.trim().endsWith("|") && (l.match(/\|/g) ?? []).length >= 2)
const isSep = (l) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l.trim())
const ORPHAN = "(table rows without their header row: the column meanings were not in the search result)"
/** Maximal runs of table lines; `before` is the line right above each. */
function tablesIn(text) {
  const runs = []
  let cur = null
  let prev = ""
  for (const l of text.split("\n")) {
    if (isTableLine(l)) {
      if (!cur) {
        cur = []
        cur.before = prev
      }
      cur.push(l)
    } else if (cur) {
      runs.push(cur)
      cur = null
    }
    prev = l
  }
  if (cur) runs.push(cur)
  return runs
}
/**
 * The table rule: every table in `out` starts with its header and separator, or (rows the page gave
 * without one) sits under the orphan label with no separator anywhere, so no header was invented; and
 * every line of it is the page's own.
 */
function checkTables(out, raw, label) {
  const rawLines = new Set(raw.split("\n").map((l) => l.trim()))
  for (const t of tablesIn(out)) {
    if (t.before === ORPHAN) ok(!t.some(isSep), `${label}: rows without a header got a separator: ${t[0].slice(0, 80)}`)
    else ok(t.length >= 2 && isSep(t[1]), `${label}: a table without its header and separator: ${t[0].slice(0, 80)}`)
    for (const l of t) ok(rawLines.has(l.trim()), `${label}: a table line that isn't in the page: ${l.slice(0, 80)}`)
  }
}
const urlsOf = (text) => [...text.matchAll(/^URL: (\S+)/gm)].map((m) => m[1])

await test("hygiene: websearch numResults default 5, ceiling 6; other tools untouched", async () => {
  const before = async (tool, args) => {
    const o = { args }
    await H["tool.execute.before"]({ tool, sessionID: "s", callID: "c" }, o)
    return o.args
  }
  eq((await before("websearch", { query: "q" })).numResults, 5, "default")
  eq((await before("websearch", { query: "q", numResults: 10 })).numResults, 6, "ceiling")
  eq((await before("websearch", { query: "q", numResults: 3 })).numResults, 3, "fewer is fine")
  eq((await before("websearch", { query: "q", numResults: "4" })).numResults, 4, "a numeric string")
  eq((await before("websearch", { query: "q", numResults: -2 })).numResults, 5, "nonsense: the default")
  eq(await before("bash", { command: "ls", numResults: 99 }), { command: "ls", numResults: 99 }, "bash is left alone")
})

await test("hygiene: the websearch definition is {query, numResults}; other tools keep theirs", async () => {
  const out = { description: "x", parameters: {} }
  await H["tool.definition"]({ toolID: "websearch" }, out)
  eq(Object.keys(out.jsonSchema.properties), ["query", "numResults"], "two parameters")
  eq(out.jsonSchema.required, ["query"], "query required")
  ok(out.description.includes("up to 5 results") && out.description.includes(`The current year is ${new Date().getFullYear()}`), "short description, year kept")
  ok(out.description.length < 450, `description is short (${out.description.length})`)
  for (const id of ["webfetch", "bash", "read", "grep", "glob"]) {
    const o = { description: "orig", parameters: { p: 1 } }
    await H["tool.definition"]({ toolID: id }, o)
    eq(o, { description: "orig", parameters: { p: 1 } }, `${id} untouched`)
  }
  // With the eval replay on too, websearch gets the hygiene definition (as in production) and webfetch the built-in's.
  const both = await withEnv({ SYRUP_EVAL_REPLAY: cassetteFile, SYRUP_CONTEXT_HYGIENE: undefined }, () => P.SyrupPlugin({}))
  const ws = { description: "x" }
  await both["tool.definition"]({ toolID: "websearch" }, ws)
  eq(ws.jsonSchema, out.jsonSchema, "replay + hygiene: websearch as in production")
  const wf = { description: "x" }
  await both["tool.definition"]({ toolID: "webfetch" }, wf)
  eq(wf.jsonSchema, FIXTURE.tools.find((t) => t.id === "webfetch").parameters, "replay + hygiene: webfetch is the built-in's")
  eq(Object.keys(both.tool).sort(), ["webfetch", "websearch"], "the replay tools are still there")
})

await test("hygiene: the six real K2 searches are trimmed to ≤ 8,000 characters, URLs and whole tables kept", async () => {
  eq(K2.length, 6, "six searches in the export")
  let raw = 0
  let kept = 0
  for (const s of K2) {
    const o = await after("websearch", s.input, s.output)
    const label = s.input.query
    eq(o.metadata.trim, "passages", `${label}: parsed`)
    eq(o.metadata.rawChars, s.output.length, `${label}: rawChars`)
    eq(o.metadata.keptChars, o.output.length, `${label}: keptChars`)
    eq(o.metadata.truncated, false, `${label}: OpenCode's own metadata kept`)
    ok(o.output.length <= 8_000, `${label}: ${o.output.length} > 8,000`)
    ok(o.output.length >= 3_000, `${label}: ${o.output.length} is suspiciously little`)
    const rawUrls = [...new Set(urlsOf(s.output))]
    const shown = urlsOf(o.output)
    eq(shown, rawUrls.slice(0, 5), `${label}: the first 5 results, in Exa's order, each with its URL`)
    for (const u of rawUrls.slice(5)) ok(o.output.includes(u), `${label}: a result past the 5th still names its URL`)
    checkTables(o.output, s.output, label)
    eq((await after("websearch", s.input, s.output)).output, o.output, `${label}: deterministic`)
    eq((await after("websearch", s.input, o.output)).output, o.output, `${label}: trimming a trimmed result changes nothing`)
    raw += s.output.length
    kept += o.output.length
  }
  ok(kept / raw < 0.25, `kept ${kept} of ${raw} characters`)
  // What the answers needed is still there.
  const cost = (await after("websearch", K2[3].input, K2[3].output)).output
  ok(cost.includes("| Price of Full Guided Expedition | US$ 29,900 |") && cost.includes("| TOTAL PRICE | US$ 29,900 |"), "the cost search keeps Apricot's full-board summary table")
  const fx = (await after("websearch", K2[5].input, K2[5].output)).output
  ok(/27[6-9]\.\d+/.test(fx), "the exchange-rate search keeps a USD/PKR rate")
  // Search 1: Wikipedia's top-10 rows came without their header; they are kept whole, under the label.
  const peaks = (await after("websearch", K2[0].input, K2[0].output)).output
  const rows = tablesIn(peaks).find((t) => t[0].startsWith("| 1 | Mount Everest"))
  ok(rows, "the top-10 peaks rows are kept")
  eq(rows.before, ORPHAN, "under the label")
  eq(rows.map((r) => r.split("|")[1].trim()), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], "all ten, in order, none split off")
})

await test("hygiene: a table that fits is kept entire", async () => {
  const s = K2[3]
  const out = (await after("websearch", s.input, s.output)).output
  const rawLines = s.output.split("\n").map((l) => l.trim())
  let whole = 0
  for (const t of tablesIn(out)) {
    if (out.includes(`${t.at(-1)}\n(table cut`)) continue
    const at = rawLines.indexOf(t[0].trim())
    let end = at
    while (end < rawLines.length && isTableLine(rawLines[end])) end++
    const kept = new Set(t.map((l) => l.trim()))
    for (const l of rawLines.slice(at, end)) ok(kept.has(l), `a kept table lost a row: ${l.slice(0, 80)}`)
    whole++
  }
  ok(whole >= 2, `at least two whole tables (${whole})`)
})

const block = (title, url, body) => `Title: ${title}\nURL: ${url}\nPublished: 2026-05-01T00:00:00.000Z\nAuthor: N/A\nHighlights:\n${body}`
const join = (...b) => b.join("\n\n---\n\n")
/** A last result long enough that the whole output is over the 6,000-character target, so it gets trimmed. */
const FILLER = block("Filler", "https://z.example/filler", "Unrelated filler text about gardening and the weather in spring. ".repeat(110))
const PRICE_HEAD = "| Package | Base Camp | Full Board |\n| --- | --- | --- |"

await test("hygiene: a price table split across highlights stays one table under its header", async () => {
  const raw = join(
    block("K2 prices", "https://a.example/k2", `Our K2 expedition prices for 2026.\n\n${PRICE_HEAD}\n| Joint | 12,490 | 29,900 |\n| Private | 18,000 | 39,900 |\n...\n| Solo | 25,000 | 49,900 |\n| Winter | 18,900 | 39,900 |`),
    block("Other", "https://b.example/x", "Some other page about K2 expedition prices, which vary a lot by operator and season."),
    FILLER,
  )
  const out = (await after("websearch", { query: "k2 expedition price" }, raw)).output
  const t = tablesIn(out)
  eq(t.length, 1, "one table")
  eq(t[0].map((l) => l.trim()), [...PRICE_HEAD.split("\n"), "| Joint | 12,490 | 29,900 |", "| Private | 18,000 | 39,900 |", "| Solo | 25,000 | 49,900 |", "| Winter | 18,900 | 39,900 |"], "header, separator and all four rows")
  checkTables(out, raw, "split table")
})

await test("hygiene: rows that lost their header stay whole under a label, never relabelled", async () => {
  const raw = join(
    block("K2 prices", "https://a.example/k2", `${PRICE_HEAD}\n| Joint | 12,490 | 29,900 |\n...\nPrices below are for treks, not expeditions.\n...\n| Trek A | 1,790 | 2,250 |\n| Trek B | 1,990 | 2,550 |\n...\n| 1 | Everest | 8,849 m | Nepal |`),
    FILLER,
  )
  const out = (await after("websearch", { query: "k2 expedition price" }, raw)).output
  const t = tablesIn(out)
  const head = t.find((x) => x.includes("| Joint | 12,490 | 29,900 |"))
  eq(head.map((l) => l.trim()), [...PRICE_HEAD.split("\n"), "| Joint | 12,490 | 29,900 |"], "the headed table keeps only its own row: the trek rows after the text are not attached to it")
  const treks = t.find((x) => x[0].includes("Trek A"))
  eq([treks.before, treks.map((l) => l.trim())], [ORPHAN, ["| Trek A | 1,790 | 2,250 |", "| Trek B | 1,990 | 2,550 |"]], "the trek rows: whole, under the label, no header")
  ok(!out.includes(`${PRICE_HEAD}\n| Trek A`) && !/\| --- \|[^\n]*\n\| Trek A/.test(out), "no header invented for them")
  const everest = t.find((x) => x[0].includes("Everest"))
  eq(everest?.before, ORPHAN, "a one-row fragment with another column count: its own block, labelled")
  eq(out.split(ORPHAN).length - 1, 2, "one label per headerless block")
  checkTables(out, raw, "orphans")
})

await test("hygiene: a table bigger than the budget keeps its header, its best rows, and says it was cut", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| Peak ${i + 1} | ${(8000 - i).toLocaleString("en-US")} m | permit fee USD ${(1000 + i * 10).toLocaleString("en-US")} |`)
  const raw = join(block("Permits", "https://p.example/permits", `| Peak | Height | Fee |\n| --- | --- | --- |\n${rows.join("\n")}`), block("Two", "https://q.example/two", "Permit fees for Pakistan's peaks are set by the Gilgit-Baltistan government each year."))
  const o = await after("websearch", { query: "permit fee peak 120" }, raw)
  ok(o.output.length <= 8_000, `≤ 8,000 (${o.output.length})`)
  const t = tablesIn(o.output)
  eq(t.length, 1, "one table")
  ok(isSep(t[0][1]) && t[0][0].includes("| Peak | Height | Fee |"), "header and separator first")
  ok(/\(table cut: \d+ of 300 rows shown\)/.test(o.output), "a note says how much was cut")
  ok(o.output.includes("| Peak 120 |"), "the row the query names is among the kept rows")
  ok(o.output.includes("https://q.example/two"), "the other result's URL is kept")
  checkTables(o.output, raw, "huge table")
})

await test("hygiene: malformed output falls back to a plain cut; a few broken blocks are dropped", async () => {
  const junk = `Results:\n${"Something about K2 that is not Exa's format at all. ".repeat(400)}`
  const o = await after("websearch", { query: "k2" }, junk)
  eq(o.metadata.trim, "cut", "plain cut")
  ok(o.output.length <= 8_000 && o.output.startsWith("Results:") && /trimmed to its first [\d,]+ of [\d,]+ characters/.test(o.output), "≤ 8,000 with a note")
  const short = "Something short that isn't Exa's format."
  eq((await after("websearch", { query: "k2" }, short)).output, short, "short odd output is left alone")
  eq((await after("websearch", { query: "k2" }, "No search results found. Please try a different query.")).output, "No search results found. Please try a different query.", "OpenCode's miss message is left alone")
  const mixed = join(block("Good", "https://g.example/1", "K2 permit fee is USD 5,000 per climber in summer."), "Title: Broken block without a URL\nHighlights:\nnothing", block("Good 2", "https://g.example/2", "K2 base camp trek costs about USD 2,000."), FILLER)
  const m = await after("websearch", { query: "k2 permit fee" }, mixed)
  eq(m.metadata.trim, "passages", "still parsed")
  eq(urlsOf(m.output), ["https://g.example/1", "https://g.example/2", "https://z.example/filler"], "the broken block is dropped, the good ones kept")
  const mostlyBroken = join("Title: a\nno url", "Title: b\nno url", block("Good", "https://g.example/1", "x".repeat(9000)))
  eq((await after("websearch", { query: "k2" }, mostlyBroken)).metadata.trim, "cut", "mostly broken: the plain cut")
})

await test("hygiene: small results are left as they are; blocks joined by a blank line parse too", async () => {
  const cassette = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "eval", "cassettes", "budget-table.json"), "utf8"))
  const small = cassette.entries.find((e) => e.tool === "websearch").output
  const o = await after("websearch", { query: "hunza hotel price" }, small)
  eq([o.output, o.metadata.trim], [small, "unchanged"], "under 6,000 characters: untouched (the budget-table case's pages)")
  const blank = [block("Hotels", "https://stay.example/h", "Mid-range hotels in Karimabad charge PKR 18,000 per night for a double room."), block("Cars", "https://drive.example/c", "A car with driver costs PKR 22,000 per day."), FILLER].join("\n\n")
  const b = (await after("websearch", { query: "hunza hotel price per night" }, blank)).output
  eq(urlsOf(b), ["https://stay.example/h", "https://drive.example/c", "https://z.example/filler"], "three results, each with its own URL")
  ok(/URL: https:\/\/stay\.example\/h\nPublished: 2026-05-01\nHighlights:\nMid-range hotels in Karimabad charge PKR 18,000/.test(b), "each passage stays under its own title and URL")
})

await test("hygiene: a huge single passage, duplicates and OpenCode's own truncation note", async () => {
  const huge = join(block("Huge", "https://h.example/1", `K2 ${"abcdefghij".repeat(6000)}`), block("Small", "https://h.example/2", "The K2 permit costs USD 5,000 per climber in summer 2026."))
  const o = await after("websearch", { query: "k2 permit cost" }, huge)
  ok(o.output.length <= 8_000, `≤ 8,000 (${o.output.length})`)
  eq(urlsOf(o.output), ["https://h.example/1", "https://h.example/2"], "both URLs kept")
  ok(o.output.includes("USD 5,000"), "the small relevant passage is kept")
  const same = "Permits for K2 cost USD 5,000 per person in the summer season, according to the Gilgit-Baltistan tourism department notice."
  const dup = join(
    block("A", "https://d.example/k2?utm_source=x", same),
    block("A again", "https://d.example/k2/", "Another passage that should not show, the URL is a duplicate of the first one entirely."),
    block("B", "https://e.example/k2", `${same} Copied.`),
    block("C", "https://f.example/k2", "Liaison officer allowances run USD 1,500 to 2,000 for a K2 expedition."),
    FILLER,
  )
  const d = (await after("websearch", { query: "k2 permit cost" }, dup)).output
  eq(urlsOf(d), ["https://d.example/k2?utm_source=x", "https://e.example/k2", "https://f.example/k2", "https://z.example/filler"], "a duplicate URL (utm, trailing slash) is dropped")
  eq(d.split("Permits for K2 cost USD 5,000").length - 1, 1, "a near-duplicate passage is kept once")
  const truncated = `${K2[1].output.slice(0, 20_000)}\n\n...7321 bytes truncated...\n\nThe tool call succeeded but the output was truncated. Full output saved to: ~/.local/share/opencode/tool-output/tool_x\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
  const t = (await after("websearch", K2[1].input, truncated)).output
  ok(!t.includes("tool-output") && !t.includes("Task tool"), "OpenCode's note about a saved file is dropped (the model shouldn't read it)")
})

await test("hygiene: webfetch is capped at 12,000 characters with a note, tables kept whole at the cut", async () => {
  const para = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i} about climbing K2 and its permits, porters and base camp logistics.`).join("\n\n")
  const table = `| Item | USD |\n| --- | --- |\n${Array.from({ length: 60 }, (_, i) => `| Item ${i} | ${(i + 1) * 100} |`).join("\n")}`
  const page = `# K2 costs\n\n${para(137)}\n\n${table}\n\n${para(100)}`
  const at = page.indexOf("| Item |")
  ok(at < 12_000 && at + table.length > 12_000, "the fixture's table straddles the cap")
  const o = await after("webfetch", { url: "https://k.example/costs", format: "markdown" }, page)
  ok(o.output.length <= 12_000, `≤ 12,000 (${o.output.length})`)
  ok(/\[Page trimmed to its first [\d,]+ of [\d,]+ characters to save context\.\]$/.test(o.output), "a note")
  ok(!o.output.includes("| Item 0 |"), "the straddling table moved past the cut, whole")
  eq([o.metadata.trim, o.metadata.rawChars], ["cut", page.length], "metadata")
  const short = "# Short page\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"
  eq((await after("webfetch", { url: "https://k.example/s" }, short)).output, short, "a short page is untouched")
  const big = `${table.split("\n").slice(0, 2).join("\n")}\n${Array.from({ length: 900 }, (_, i) => `| Row ${i} | ${i} |`).join("\n")}`
  const b = (await after("webfetch", { url: "https://k.example/b" }, big)).output
  ok(b.length <= 12_000 && b.startsWith("| Item | USD |\n| --- | --- |\n| Row 0 |"), "a page that is one huge table keeps its header and whole rows")
  checkTables(b.replace(/\n\n\[Page trimmed[^\]]*\]$/, ""), big, "huge page table")
})

await test("hygiene: coding tools are never touched", async () => {
  const log = `${"error: something failed\n".repeat(5000)}`
  for (const tool of ["bash", "read", "grep", "glob", "edit", "task"]) {
    const o = await after(tool, {}, log)
    eq([o.output === log, o.metadata], [true, { truncated: false }], `${tool} untouched`)
  }
})

const tool = (id, toolName, input, output, status = "completed") => ({ id, type: "tool", tool: toolName, callID: `call_${id}`, state: { status, input, output, title: "t", metadata: {}, time: { start: 1, end: 2 } } })
const msg = (role, id, parts, extra = {}) => ({ info: { id, role, sessionID: "ses_1", ...extra }, parts })
const text = (t) => ({ type: "text", text: t })

await test("hygiene: web results of earlier user turns become a stub with the query and up to 5 sources", async () => {
  const s0 = K2[3]
  const messages = [
    msg("user", "u1", [text("k2 cost?")]),
    msg("assistant", "a1", [tool("p1", "websearch", s0.input, s0.output), tool("p2", "webfetch", { url: "https://www.apricottours.pk/tours/k2-expedition/" }, "page text ".repeat(500)), tool("p3", "bash", { command: "ls" }, "a.txt"), text("It costs $30k.")]),
    msg("user", "u2", [text("in PKR")]),
    msg("assistant", "a2", [tool("p4", "websearch", K2[5].input, K2[5].output)]),
  ]
  const before = JSON.parse(JSON.stringify(messages))
  await H["experimental.chat.messages.transform"]({}, { messages })
  const urls = [...new Set(urlsOf(s0.output))].slice(0, 5)
  const titles = [...s0.output.matchAll(/^Title: (.*)$/gm)].map((m) => m[1].trim())
  const clip = (s) => (s.length > 80 ? `${s.slice(0, 79)}…` : s)
  const expect = `[Earlier web search "${s0.input.query}" cleared to save context. Sources: ${urls.map((u, i) => `${clip(titles[i])} ${u}`).join("; ")}. The answer given at the time is in the conversation above. Search again or webfetch a URL if you need the details.]`
  eq(messages[1].parts[0].state.output, expect, "the search stub")
  eq(messages[1].parts[1].state.output, "[Earlier fetch of https://www.apricottours.pk/tours/k2-expedition/ cleared to save context. Fetch it again if needed.]", "the fetch stub")
  eq(messages[1].parts[2], before[1].parts[2], "bash untouched")
  eq(messages[1].parts[3], before[1].parts[3], "assistant text untouched")
  eq(messages[3].parts[0].state.output, K2[5].output, "the current turn keeps its result verbatim")
  for (const [i, j] of [[1, 0], [1, 1]]) {
    const noOutput = (state) => ({ ...state, output: null })
    eq([messages[i].parts[j].callID, noOutput(messages[i].parts[j].state)], [before[i].parts[j].callID, noOutput(before[i].parts[j].state)], "inputs, ids and everything but the output untouched")
  }
  // Same input, byte-identical stub: the masked prefix never changes between steps.
  const again = JSON.parse(JSON.stringify(before))
  await H["experimental.chat.messages.transform"]({}, { messages: again })
  eq(again[1].parts[0].state.output, expect, "deterministic")
  // A stub from an already trimmed result lists the same sources.
  const trimmed = (await after("websearch", s0.input, s0.output)).output
  const t2 = [msg("user", "u1", []), msg("assistant", "a1", [tool("p1", "websearch", s0.input, trimmed)]), msg("user", "u2", [])]
  await H["experimental.chat.messages.transform"]({}, { messages: t2 })
  eq(t2[1].parts[0].state.output, expect, "the same stub from the trimmed text")
  // Errors, running tools and compacted parts are left alone.
  const odd = [msg("user", "u1", []), msg("assistant", "a1", [tool("e", "websearch", { query: "x" }, undefined, "error"), { ...tool("c", "websearch", { query: "y" }, "old"), state: { ...tool("c", "websearch", { query: "y" }, "old").state, time: { start: 1, end: 2, compacted: 3 } } }]), msg("user", "u2", [])]
  const oddBefore = JSON.parse(JSON.stringify(odd))
  await H["experimental.chat.messages.transform"]({}, { messages: odd })
  eq(odd, oddBefore, "error and compacted parts untouched")
})

await test("hygiene: the current turn keeps its newest 3 web results, the rest only within 16K tokens", async () => {
  const page = (i) => `Page ${i} `.repeat(1_500) // 10.5k–11k characters, ~2.7k tokens each
  const parts = Array.from({ length: 8 }, (_, i) => tool(`w${i}`, "webfetch", { url: `https://x.example/${i}` }, page(i)))
  const messages = [msg("user", "u1", [text("research")]), msg("assistant", "a1", parts.slice(0, 4)), msg("assistant", "a2", parts.slice(4))]
  await H["experimental.chat.messages.transform"]({}, { messages })
  const all = [...messages[1].parts, ...messages[2].parts]
  const masked = all.map((p) => p.state.output.startsWith("[Fetch of"))
  const tokens = all.reduce((n, p) => n + p.state.output.length / 4, 0)
  ok(tokens <= 16_000, `within 16K tokens (${tokens})`)
  eq(masked.slice(-3), [false, false, false], "the newest 3 are kept")
  ok(masked[0] && masked.indexOf(false) > 0 && masked.slice(masked.indexOf(false)).every((m) => !m), "the oldest go first")
  eq(all[0].state.output, "[Fetch of https://x.example/0 cleared to save context; newer web results of this turn are kept. Fetch it again if needed.]", "the in-turn stub")
  const big = Array.from({ length: 4 }, (_, i) => tool(`b${i}`, "webfetch", { url: `https://y.example/${i}` }, "z".repeat(40_000)))
  const m2 = [msg("user", "u1", []), msg("assistant", "a1", big)]
  await H["experimental.chat.messages.transform"]({}, { messages: m2 })
  eq(m2[1].parts.map((p) => p.state.output.length), [m2[1].parts[0].state.output.length, 40_000, 40_000, 40_000], "never the newest 3, even over budget")
})

await test("hygiene: no 'continue' request after a compaction that followed a finished answer; kept mid-task", async () => {
  const fresh = await withEnv({ SYRUP_EVAL_REPLAY: undefined, SYRUP_CONTEXT_HYGIENE: undefined }, () => P.SyrupPlugin({}))
  const ev = (type, properties) => fresh.event({ event: { type, properties } })
  const user = (sid, id) => ev("message.updated", { info: { id, sessionID: sid, role: "user" } })
  const answer = (sid, id, parentID, finish, summary) => ev("message.updated", { info: { id, sessionID: sid, role: "assistant", parentID, finish, ...(summary && { summary: true }) } })
  const compaction = async (sid, id) => {
    await user(sid, id)
    await ev("message.part.updated", { part: { id: `${id}_p`, sessionID: sid, messageID: id, type: "compaction", auto: true } })
  }
  const cont = async (sid, overflow = false) => {
    const o = { enabled: true }
    await fresh["experimental.compaction.autocontinue"]({ sessionID: sid, agent: "build", overflow }, o)
    return o.enabled
  }
  // The answer finished, then the compaction: the extra request would answer a question nobody asked.
  await user("s1", "u1")
  await answer("s1", "a1", "u1", "stop")
  await compaction("s1", "c1")
  await answer("s1", "a2", "c1", "stop", true)
  eq(await cont("s1"), false, "after a finished answer: no continue")
  eq(await cont("s1", true), true, "a provider overflow: OpenCode decides")
  // Mid-task: the last step called tools, so the agent must go on after the summary.
  await user("s2", "u1")
  await answer("s2", "a1", "u1", "tool-calls")
  await compaction("s2", "c1")
  eq(await cont("s2"), true, "mid-task: continue")
  // A new question the compaction came before: it still needs its answer.
  await user("s3", "u1")
  await answer("s3", "a1", "u1", "stop")
  await user("s3", "u2")
  await compaction("s3", "c1")
  eq(await cont("s3"), true, "an unanswered question: continue")
  eq(await cont("never-seen"), true, "an unknown session: OpenCode's default")
  const off = await withEnv({ SYRUP_EVAL_REPLAY: undefined, SYRUP_CONTEXT_HYGIENE: "0" }, () => P.SyrupPlugin({}))
  eq(off["experimental.compaction.autocontinue"], undefined, "off with the hygiene")
})

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} tests passed`)
process.exit(failed ? 1 : 0)
