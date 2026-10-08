#!/usr/bin/env node
/**
 * Round G: the local origin guard (src/server/local-guard.ts), the /api/oc proxy's header handling, and the
 * credential-folder refusal shared by the proxy and the local file routes (src/server/credential-dirs.ts).
 * Bundles each module with esbuild like scripts/test-diffs.mjs; the routes' engine, database and logging imports
 * are stubbed, and fetch is faked, so no server, engine or real credential is touched. The credential folders
 * are fakes in a temp folder (SYRUP_HOME and XDG_* point there), filled with fake values; nothing prints file
 * contents, only status codes and lengths.
 *
 *   node scripts/test-guard.mjs
 */
import { build } from "esbuild"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "node_modules", ".cache", "syrup-guard-test")
fs.mkdirSync(outDir, { recursive: true })

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : err}`)
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`)
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ---- A fake home with fake credential folders. Set before any bundle loads (env.ts reads them at import). ----
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "syrup-guard-")))
const home = path.join(tmp, "home")
const vaultDir = path.join(home, "syrupcfg")
const ocData = path.join(home, ".local", "share", "opencode")
const ocConfig = path.join(home, ".config", "opencode")
for (const d of [vaultDir, ocData, path.join(home, ".local", "state"), path.join(home, "project")]) fs.mkdirSync(d, { recursive: true })
const FAKE_VAULT = "FAKE-VAULT-KEY-do-not-ship"
const FAKE_AUTH = JSON.stringify({ fake: { type: "api", key: "FAKE-PROVIDER-KEY" } })
fs.writeFileSync(path.join(vaultDir, "vault.key"), FAKE_VAULT)
fs.writeFileSync(path.join(ocData, "auth.json"), FAKE_AUTH)
fs.writeFileSync(path.join(home, "notes.txt"), "hello notes")
fs.writeFileSync(path.join(home, "project", "readme.md"), "# readme")
let junction = null
try {
  junction = path.join(home, "project", "keys")
  fs.symlinkSync(vaultDir, junction, "junction")
} catch {
  junction = null
}
const win = process.platform === "win32"
/** The same folder spelled through this disk's admin share: \\127.0.0.1\c$\…, \\localhost\C$\…, \\?\UNC\localhost\C$\…, //localhost/C$/…. */
function uncForms(p) {
  const share = `${p[0]}$${p.slice(2)}`
  const bs = "\\"
  return [
    ["\\\\127.0.0.1\\c$", `${bs}${bs}127.0.0.1${bs}${share.toLowerCase().slice(0, 2)}${share.slice(2)}`],
    ["\\\\localhost\\C$", `${bs}${bs}localhost${bs}${share}`],
    ["\\\\?\\UNC\\localhost\\C$", `${bs}${bs}?${bs}UNC${bs}localhost${bs}${share}`],
    ["//localhost/C$", `//localhost/${share.replaceAll(bs, "/")}`],
    ["\\\\?\\C:", `${bs}${bs}?${bs}${p}`],
  ]
}
Object.assign(process.env, {
  SYRUP_MODE: "local",
  SYRUP_HOME: vaultDir,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
})

/** Stubs for the routes' imports that would start an engine, open a database or log to it. */
const STUBS = {
  "@/server/engine/opencode": `export const engine = async () => ({ url: "http://engine.test" }); export const engineAuthHeader = () => "Basic engine-stub"`,
  "@/server/sarib": `export const ensureSarib = async () => {}`,
  "@/server/shares": `export const revokeLocalSessionShares = async () => {}`,
  "./log": `export const slog = () => {}`,
}
const stubPlugin = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^(@\/server\/(engine\/opencode|sarib|shares)|\.\/log)$/ }, (a) => ({ path: a.path, namespace: "stub" }))
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js" }))
  },
}

async function bundle(entry, name) {
  const outfile = path.join(outDir, `${name}.mjs`)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning", tsconfig: path.join(root, "tsconfig.json"), plugins: [stubPlugin] })
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
}

const guard = await bundle("src/server/local-guard.ts", "local-guard")
const oc = await bundle("src/app/api/oc/[...path]/route.ts", "oc-route")
const files = await bundle("src/app/api/workspace/files/route.ts", "files-route")
const creds = await bundle("src/server/credential-dirs.ts", "credential-dirs")

// ---- 1. localGuardDecision: RENDERING §3.G's table ----
const rows = [
  [1, "GET", "/api/oc/session", "127.0.0.1:3000", null, null, true],
  [2, "GET", "/api/oc/session", "127.0.0.1:3000", "http://127.0.0.1:3000", "same-origin", true],
  [3, "GET", "/api/oc/session", "localhost:3000", "http://localhost:3000", "same-origin", true],
  [4, "GET", "/api/oc/session", "127.0.0.1:3000", null, "none", true],
  [5, "GET", "/api/oc/session", "127.0.0.1:3000", "http://localhost:5173", "same-site", false],
  [6, "GET", "/api/oc/session", "127.0.0.1:3000", "http://127.0.0.1:4211", "same-site", false],
  [7, "GET", "/api/oc/session", "127.0.0.1:3000", null, "cross-site", false],
  [8, "POST", "/api/oc/session", "127.0.0.1:3000", "null", "cross-site", false],
  [9, "POST", "/api/oc/session", "127.0.0.1:3000", "http://127.0.0.1:5173", null, false],
  [10, "GET", "/api/oc/session", "evil.test", null, null, false],
  [11, "GET", "/api/oc/session", "[::1]:3000", "http://[::1]:3000", "same-origin", true],
  [12, "GET", "/api/oc/session", "127.0.0.1:3000", "https://127.0.0.1:3000", "same-origin", false],
  [13, "GET", "/c/x", "evil.test", null, null, false],
  [14, "GET", "/c/x", "127.0.0.1:3000", null, "cross-site", true],
  [15, "GET", "/c/x", "127.0.0.1:3000", null, null, true],
  // Beyond the table: no Host, a Host that only starts like loopback, Origin "null" alone, /api itself.
  [16, "GET", "/c/x", null, null, null, false],
  [17, "GET", "/", "127.0.0.1.evil.test:3000", null, null, false],
  [18, "GET", "/api/workspace/files", "127.0.0.1:3000", "null", null, false],
  [19, "GET", "/api", "127.0.0.1:3000", null, "cross-site", false],
  [20, "GET", "/apis", "127.0.0.1:3000", null, "cross-site", true],
]
for (const [n, method, pathname, host, origin, secFetchSite, want] of rows) {
  await check(`guard row ${n}: ${method} ${pathname} host=${host ?? "-"} origin=${origin ?? "-"} sfs=${secFetchSite ?? "-"} -> ${want ? "ok" : "403"}`, () => {
    const d = guard.localGuardDecision({ method, pathname, host, origin, secFetchSite })
    eq(d.ok, want, "ok")
    if (!want) eq(d.status, 403, "status")
  })
}

// ---- 1b. The proxy matcher (src/proxy.ts), compiled the way Next compiles it: every /api path runs the guard but the LLM relay route ----
await check("matcher: every /api path reaches the guard (an id ending in .txt/.png/.svg/.xml included) except the fail-closed LLM relay route; static assets don't", async () => {
  const src = fs.readFileSync(path.join(root, "src", "proxy.ts"), "utf8")
  const m = src.match(/matcher:\s*(\[.*\])/)
  ok(m, "src/proxy.ts has a one-line matcher array")
  const matcher = Function(`"use strict"; return ${m[1]}`)()
  const require = createRequire(path.join(root, "package.json"))
  const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info")
  const { getMiddlewareRouteMatcher } = require("next/dist/shared/lib/router/utils/middleware-route-matcher")
  const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers(matcher, {}))
  const runs = (p) => matches(p, { headers: {} }, {})
  for (const p of ["/api/oc/session/x.txt", "/api/memory/x.txt", "/api/skills/x.svg", "/api/shares/x.png", "/api/oc/session/x.xml", "/api/oc/session", "/api", "/c/x", "/", "/s/abc"]) eq(runs(p), true, `guard runs on ${p}`)
  for (const p of ["/_next/static/chunks/a.js", "/favicon.ico", "/logo.png", "/robots.txt"]) eq(runs(p), false, `guard skips ${p}`)
  // The one /api exception: the cloud LLM relay's own route shape (fail-closed by itself: 404 in local mode, token first in the cloud).
  for (const p of ["/api/ingest/llm/google/models", "/api/ingest/llm/google/chat/completions", "/api/ingest/llm/google/x.png"]) eq(runs(p), false, `guard skips the relay route ${p}`)
  for (const p of ["/api/ingest/logs", "/api/ingest/router/keys", "/api/ingest/memory/save", "/api/ingest/llm", "/api/ingest/llm/google", "/api/ingest/llmx/a/b", "/api/ingest/LLM/google/models"]) eq(runs(p), true, `guard runs on ${p}`)
  const relayRoute = fs.readFileSync(path.join(root, "src", "app", "api", "ingest", "llm", "[provider]", "[...path]", "route.ts"), "utf8")
  ok(/if \(!env\.isCloud\) return Response\.json\([^)]*\{ status: 404 \}\)/.test(relayRoute.replace(/\s+/g, " ")), "the relay route answers 404 in local mode before reading anything")
  // What the matched path then meets: a foreign Host is refused (the live finding: /api/oc/session/x.txt reached the engine).
  for (const p of ["/api/oc/session/x.txt", "/api/memory/x.txt", "/api/shares/x.png"]) {
    const d = guard.localGuardDecision({ method: "DELETE", pathname: p, host: "evil.test", origin: null, secFetchSite: null })
    eq(d.ok ? 200 : d.status, 403, `Host evil.test on ${p}`)
  }
})

// ---- 2. Header helpers ----
await check("proxyRequestHeaders drops origin, referer, cookie, hop-by-hop and the client's authorization", () => {
  const h = guard.proxyRequestHeaders(
    new Headers({ origin: "http://127.0.0.1:3000", referer: "http://127.0.0.1:3000/s/x", cookie: "a=b", authorization: "Bearer client", host: "127.0.0.1:3000", connection: "keep-alive", "content-type": "application/json", "x-opencode-directory": "C%3A%5Cw" }),
    "Basic engine",
  )
  for (const k of ["origin", "referer", "cookie", "host", "connection"]) eq(h.has(k), false, k)
  eq(h.get("authorization"), "Basic engine", "authorization")
  eq(h.get("content-type"), "application/json", "content-type")
  eq(h.get("x-opencode-directory"), "C%3A%5Cw", "x-opencode-directory")
})
await check("proxyResponseHeaders drops access-control-*, content-encoding and content-length; keeps content-type", () => {
  const h = guard.proxyResponseHeaders(new Headers({ "access-control-allow-origin": "*", "access-control-allow-credentials": "true", "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "10", "cache-control": "no-cache" }))
  eq([...h.keys()].sort(), ["cache-control", "content-type"], "headers")
})

// ---- 3. The /api/oc route itself, with a fake engine ----
const engineCalls = []
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url))
  engineCalls.push({ path: u.pathname, headers: new Headers(init?.headers) })
  const cors = { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" }
  if (u.pathname === "/config") return new Response(JSON.stringify({ model: "syrup/fast", provider: { fake: { name: "Fake", options: { apiKey: "FAKE-ROUTER-SECRET", baseURL: "http://127.0.0.1:4210/v1" } } } }), { headers: { ...cors, "content-type": "application/json" } })
  return new Response("[]", { headers: { ...cors, "content-type": "text/plain" } })
}
const ocGet = (route, query, headers = {}) =>
  oc.GET(new Request(`http://127.0.0.1:3000/api/oc/${route}?${new URLSearchParams(query)}`, { headers }), { params: Promise.resolve({ path: route.split("/") }) })
const browserHeaders = { origin: "http://127.0.0.1:3000", referer: "http://127.0.0.1:3000/s/1", cookie: "theme=dark", authorization: "Bearer client" }

await check("route: GET config is redacted and carries no access-control-* header", async () => {
  engineCalls.length = 0
  const r = await ocGet("config", { directory: home }, browserHeaders)
  eq(r.status, 200, "status")
  eq([...r.headers.keys()].filter((k) => k.startsWith("access-control-")), [], "access-control headers")
  const body = await r.text()
  ok(!body.includes("FAKE-ROUTER-SECRET"), `the router secret was not redacted (body ${body.length} chars)`)
  ok(body.includes("baseURL"), "non-secret options survive")
  const sent = engineCalls[0]?.headers
  ok(sent, "the engine was called")
  for (const k of ["origin", "referer", "cookie"]) eq(sent.has(k), false, `engine saw ${k}`)
  eq(sent.get("authorization"), "Basic engine-stub", "engine authorization")
})
await check("route: a streamed answer (GET session) carries no access-control-* header", async () => {
  const r = await ocGet("session", { directory: home }, browserHeaders)
  eq(r.status, 200, "status")
  eq([...r.headers.keys()].filter((k) => k.startsWith("access-control-")), [], "access-control headers")
  eq(r.headers.get("content-type"), "text/plain", "content-type")
})
await check("route: syrup's config folder as the session folder is refused, the engine never asked", async () => {
  engineCalls.length = 0
  eq((await ocGet("session", { directory: vaultDir })).status, 403, "status")
  eq((await ocGet("session", { directory: path.join(ocData, "..", "opencode") })).status, 403, "status (engine data folder, dotted)")
  eq(engineCalls.length, 0, "engine calls")
})
await check("route: the file list refuses a path into the engine's data folder", async () => {
  engineCalls.length = 0
  eq((await ocGet("file", { directory: home, path: ".local/share/opencode" })).status, 403, "status")
  eq(engineCalls.length, 0, "engine calls")
})
await check("route: a UNC or device spelling of a folder (\\\\127.0.0.1\\c$\\…) is refused, query and header, the engine never asked", async () => {
  if (!win) return console.log("     (Windows only; skipped)")
  engineCalls.length = 0
  for (const [label, d] of uncForms(ocData)) {
    eq((await ocGet("file", { directory: d, path: "" })).status, 400, `${label} as the directory`)
    eq((await ocGet("session", {}, { "x-opencode-directory": encodeURIComponent(d) })).status, 400, `${label} in x-opencode-directory`)
  }
  // An ordinary folder spelled as UNC is refused too: the rule is "drive letters only", not a list of bad hosts.
  eq((await ocGet("session", { directory: uncForms(home)[0][1] })).status, 400, "an ordinary folder over UNC")
  eq((await ocGet("file", { directory: home, path: uncForms(ocData)[0][1] })).status, 403, "a UNC path into the data folder as the file-list path")
  eq(engineCalls.length, 0, "engine calls")
})
await check("route: a directory the engine would decode again (%XX) is refused before the engine sees it", async () => {
  // dd\xA and dd\x%41: the engine decodes the query value once more, so "x%41" would open "xA".
  const dd = path.join(home, "dd")
  for (const d of ["xA", "x%41", path.join("sub", "%2e%2e", "target"), "target", "100%"]) fs.mkdirSync(path.join(dd, d), { recursive: true })
  engineCalls.length = 0
  eq((await ocGet("session", { directory: path.join(dd, "x%41") })).status, 400, "x%41")
  eq((await ocGet("session", { directory: path.join(dd, "sub", "%2e%2e", "target") })).status, 400, "an encoded .. that climbs out")
  eq((await ocGet("session", { directory: path.join(home, "%2elocal", "share", "opencode") })).status, 400, "an encoded credential folder")
  eq(engineCalls.length, 0, "engine calls")
  // A lone "%" is not an escape: the engine keeps it as is, so it passes (no regression for "100%").
  eq((await ocGet("session", { directory: path.join(dd, "100%") })).status, 200, "100%")
  // The file-list path is checked decoded once more too.
  eq((await ocGet("file", { directory: home, path: "%2elocal/share/opencode" })).status, 403, "file-list path %2elocal")
})
await check("route: an NTFS stream spelling of the data folder (opencode::$INDEX_ALLOCATION) is refused", async () => {
  if (!win) return console.log("     (Windows only; skipped)")
  eq((await ocGet("session", { directory: `${ocData}::$INDEX_ALLOCATION` })).status, 403, "directory")
  eq((await ocGet("file", { directory: home, path: ".local/share/opencode::$INDEX_ALLOCATION" })).status, 403, "file-list path")
})

// ---- 4. The shared helper ----
await check("credential-dirs: the fake folders are the credential folders; ordinary ones are not", () => {
  eq(creds.isCredentialPath(path.join(vaultDir, "vault.key")), true, "vault.key")
  eq(creds.isCredentialPath(path.join(ocData, "auth.json")), true, "auth.json")
  eq(creds.isCredentialPath(ocConfig), true, "engine config folder (missing on disk)")
  eq(creds.isCredentialPath(home), false, "home")
  eq(creds.isCredentialPath(path.join(home, "syrupcfg-other")), false, "a sibling with the same prefix")
  if (process.platform === "win32") eq(creds.isCredentialPath(path.join(vaultDir.toUpperCase(), "VAULT.KEY")), true, "case-insensitive on Windows")
  if (junction) eq(creds.isCredentialPath(path.join(junction, "vault.key")), true, "through a junction")
})

// ---- 5. The local file route: /api/workspace/files ----
const filesGet = (query) => files.GET(new Request(`http://127.0.0.1:3000/api/workspace/files?${new URLSearchParams(query)}`))
const status = async (query) => (await filesGet(query)).status

await check("files: ordinary files still read (raw 200, exact length; stat 200)", async () => {
  const r = await filesGet({ op: "raw", workspace: home, path: "notes.txt" })
  eq(r.status, 200, "raw status")
  eq((await r.arrayBuffer()).byteLength, "hello notes".length, "raw length")
  eq(await status({ op: "stat", workspace: home, path: "project/readme.md" }), 200, "stat status")
})
await check("files: op=raw and op=stat refuse syrup's vault key from a home-folder workspace", async () => {
  eq(await status({ op: "raw", workspace: home, path: "syrupcfg/vault.key" }), 403, "raw")
  eq(await status({ op: "stat", workspace: home, path: "syrupcfg/vault.key" }), 403, "stat")
  eq(await status({ op: "stat", workspace: home, path: "syrupcfg" }), 403, "stat folder")
})
await check("files: op=raw and op=stat refuse the engine's auth.json", async () => {
  eq(await status({ op: "raw", workspace: home, path: ".local/share/opencode/auth.json" }), 403, "raw")
  eq(await status({ op: "stat", workspace: home, path: ".local/share/opencode/auth.json" }), 403, "stat")
})
await check("files: the credential folder itself as the workspace is refused", async () => {
  eq(await status({ op: "raw", workspace: vaultDir, path: "vault.key" }), 403, "raw")
  eq(await status({ op: "stat", workspace: ocData, path: "auth.json" }), 403, "stat")
  eq(await status({ op: "zip", workspace: vaultDir, path: "" }), 403, "zip")
})
await check("files: a junction into the config folder does not get around it", async () => {
  if (!junction) return console.log("     (no junction could be made here; skipped)")
  eq(await status({ op: "raw", workspace: home, path: "project/keys/vault.key" }), 403, "raw through junction")
  eq(await status({ op: "raw", workspace: junction, path: "vault.key" }), 403, "junction as workspace")
})
await check("files: a zip of the home folder (hidden files included) leaves the credential folders out", async () => {
  const r = await filesGet({ op: "zip", workspace: home, path: "", hidden: "1" })
  eq(r.status, 200, "status")
  const bytes = Buffer.from(await r.arrayBuffer())
  eq(r.headers.get("x-file-count"), "2", "file count (notes.txt, project/readme.md)")
  ok(bytes.includes("notes.txt") && bytes.includes("project/readme.md"), "the ordinary files are in it")
  ok(!bytes.includes("vault.key") && !bytes.includes("auth.json"), `a credential file is in the zip (${bytes.length} bytes)`)
  ok(!bytes.includes(FAKE_VAULT), "the vault key's bytes are in the zip")
})
await check("files: an upload can't create or write into a credential folder", async () => {
  const body = new TextEncoder().encode("export default {}")
  const post = (p) => files.POST(new Request(`http://127.0.0.1:3000/api/workspace/files?${new URLSearchParams({ op: "upload", workspace: home, path: p, offset: "0", total: String(body.length) })}`, { method: "POST", body, headers: { "x-chunk-size": String(body.length) } }))
  eq((await post(".config/opencode/plugin/x.js")).status, 403, "into the engine's config folder")
  eq(fs.existsSync(ocConfig), false, "the engine's config folder was created")
  eq((await post("syrupcfg/x.txt")).status, 403, "into syrup's config folder")
  eq(fs.readdirSync(vaultDir).sort(), ["vault.key"], "syrup's config folder unchanged")
  const r = await post("project/up.txt")
  eq(r.status, 200, "an ordinary upload")
  eq(fs.readFileSync(path.join(home, "project", "up.txt"), "utf8").length, body.length, "uploaded length")
})
await check("files: a UNC or device spelling of the home folder (\\\\127.0.0.1\\c$\\…) can't reach vault.key or auth.json, nor anything else", async () => {
  if (!win) return console.log("     (Windows only; skipped)")
  for (const [label, ws] of uncForms(home)) {
    eq(await status({ op: "raw", workspace: ws, path: "syrupcfg/vault.key" }), 400, `${label}: raw vault.key`)
    eq(await status({ op: "stat", workspace: ws, path: ".local/share/opencode/auth.json" }), 400, `${label}: stat auth.json`)
    eq(await status({ op: "raw", workspace: ws, path: "notes.txt" }), 400, `${label}: an ordinary file`)
  }
  for (const [label, ws] of uncForms(vaultDir)) eq(await status({ op: "zip", workspace: ws, path: "" }), 400, `${label}: zip of syrup's config folder`)
  const body = new TextEncoder().encode("x")
  const up = await files.POST(new Request(`http://127.0.0.1:3000/api/workspace/files?${new URLSearchParams({ op: "upload", workspace: uncForms(home)[0][1], path: "project/unc.txt", offset: "0", total: "1" })}`, { method: "POST", body, headers: { "x-chunk-size": "1" } }))
  eq(up.status, 400, "upload into a UNC workspace")
  eq(fs.existsSync(path.join(home, "project", "unc.txt")), false, "the upload landed")
})
await check("files: a hard link to auth.json or vault.key inside a workspace is refused, and a zip leaves it out", async () => {
  const links = path.join(home, "links")
  fs.mkdirSync(links)
  try {
    fs.linkSync(path.join(ocData, "auth.json"), path.join(links, "a.json"))
    fs.linkSync(path.join(vaultDir, "vault.key"), path.join(links, "k.bin"))
    fs.linkSync(path.join(home, "notes.txt"), path.join(links, "n.txt"))
  } catch (err) {
    return console.log(`     (no hard link could be made here: ${err.code}; skipped)`)
  }
  eq(await status({ op: "raw", workspace: links, path: "a.json" }), 403, "raw, link to auth.json")
  eq(await status({ op: "stat", workspace: links, path: "a.json" }), 403, "stat, link to auth.json")
  eq(await status({ op: "raw", workspace: home, path: "links/k.bin" }), 403, "raw, link to vault.key")
  eq(await status({ op: "raw", workspace: links, path: "n.txt" }), 200, "a hard link to an ordinary file still reads")
  const r = await filesGet({ op: "zip", workspace: links, path: "" })
  eq(r.status, 200, "zip status")
  const bytes = Buffer.from(await r.arrayBuffer())
  eq(r.headers.get("x-file-count"), "1", "zip file count (n.txt only)")
  ok(!bytes.includes(FAKE_VAULT) && !bytes.includes("FAKE-PROVIDER-KEY"), `a credential's bytes are in the zip (${bytes.length} bytes)`)
  eq(creds.isCredentialPath(path.join(links, "a.json")), true, "isCredentialPath on the link")
})
await check("credential-dirs: UNC and device spellings count as credential paths (fail closed); \\\\?\\C: of an ordinary folder too", () => {
  if (!win) return console.log("     (Windows only; skipped)")
  for (const [label, p] of uncForms(path.join(vaultDir, "vault.key"))) eq(creds.isCredentialPath(p), true, label)
  for (const [label, p] of uncForms(home)) eq(creds.isLocalDrivePath(p), false, `isLocalDrivePath ${label}`)
  eq(creds.isLocalDrivePath(home), true, "isLocalDrivePath on the plain path")
  eq(creds.isCredentialPath(`${ocData}::$INDEX_ALLOCATION`), true, "NTFS stream spelling of the data folder")
})

if (junction) fs.unlinkSync(junction)
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(failed ? 1 : 0)
