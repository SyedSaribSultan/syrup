#!/usr/bin/env node
/**
 * Prints a local chat as Markdown or JSON, for pasting into another tool or
 * debugging with an agent that reads files.
 *
 *   pnpm chat:export <sessionId|latest> [--json] [--debug] [--url http://127.0.0.1:3000] [--directory <folder>]
 *
 *   --json       syrup.transcript v1 JSON instead of Markdown
 *   --debug      add router events (backend per step, attempts, reasons, ttft,
 *                latency, errors), tool errors and logs for the chat
 *   --url        where syrup is running (default $SYRUP_URL or http://127.0.0.1:3000)
 *   --directory  the chat's workspace folder (optional; syrup searches its projects)
 *
 * Talks to the running local syrup server (which reads the engine and
 * data/syrup.db) and renders with the same serializers as share links
 * (src/lib/transcript.ts, bundled here with esbuild). Output is sanitized the
 * same way: secrets redacted, paths workspace-relative.
 */
import { build } from "esbuild"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const positional = args.filter((a, i) => !a.startsWith("--") && !["--url", "--directory"].includes(args[i - 1]))

if (flag("--help") || flag("-h") || positional.length !== 1) {
  console.error("usage: pnpm chat:export <sessionId|latest> [--json] [--debug] [--url http://127.0.0.1:3000] [--directory <folder>]")
  process.exit(positional.length === 1 ? 0 : 2)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "node_modules", ".cache", "syrup-chat-export")
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, "transcript.mjs")
await build({
  entryPoints: [path.join(root, "src", "lib", "transcript.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  alias: { "@": path.join(root, "src") },
})
const T = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)

const base = (opt("--url") ?? process.env.SYRUP_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "")
const q = new URLSearchParams({ session: positional[0], format: "bundle" })
if (flag("--debug")) q.set("debug", "1")
const dir = opt("--directory")
if (dir) q.set("directory", path.resolve(dir))

let res
try {
  res = await fetch(`${base}/api/shares/export?${q}`, { headers: { accept: "application/json" } })
} catch (err) {
  console.error(`Could not reach syrup at ${base} (${err.cause?.code ?? err.message}). Is it running? Start it with \`pnpm dev\`, or pass --url.`)
  process.exit(1)
}
const body = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`syrup answered ${res.status}: ${body.error ?? "unknown error"}`)
  process.exit(1)
}

const { transcript, debug } = body
let out
if (flag("--json")) out = T.renderJSON(debug ?? transcript)
else out = debug ? T.renderDebugMarkdown(debug) : T.renderMarkdown(transcript)
process.stdout.write(out)
console.error(`\n[chat:export] ${transcript.title} · session ${body.sessionId} · ${transcript.stats.messages} messages · ${transcript.stats.redactions} redactions`)
