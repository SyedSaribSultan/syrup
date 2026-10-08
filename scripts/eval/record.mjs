#!/usr/bin/env node
/**
 * Builds an eval cassette from an exported chat: every completed web tool call (websearch,
 * webfetch, codesearch) with its input, title and full output, keyed the way syrup's plugin looks
 * them up (src/server/engine/syrup-plugin.ts). No network, no quota.
 *
 *   pnpm eval:record <export.md|export.json> --case <id> [--out <file>] [--turns 1-7]
 *
 *   --case   names the cassette: scripts/fixtures/eval/cassettes/<id>.json (unless --out)
 *   --turns  only tool calls made in these user turns (default: all)
 *
 * Refuses (exit 1) an export whose tool outputs were shortened to fit the share size cap
 * ("… [output shortened: …]"): a replay must give the model exactly what the real tool gave.
 * Export the chat again with `pnpm chat:export <id> --json` (it keeps outputs whole up to 5 MB).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadChecks, ROOT } from "./load-checks.mjs"

export const WEB_TOOLS = new Set(["websearch", "webfetch", "codesearch"])
const CLIPPED = /… \[(output|tool output) shortened: \d+ more characters\]/

/** Same keys as the plugin: lower-case query without punctuation; normalised URL. */
export function searchKey(query) {
  return String(query)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}
export function urlKey(raw) {
  try {
    const u = new URL(String(raw).trim())
    if (u.protocol === "http:") u.protocol = "https:"
    u.hash = ""
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k)
    const s = u.toString()
    return s.endsWith("/") ? s.slice(0, -1) : s
  } catch {
    return String(raw).trim()
  }
}

/** parsed: ParsedTranscript. Returns { entries, clipped: [descriptions] }. */
export function cassetteEntries(parsed, { from = 1, to = Infinity } = {}) {
  const entries = []
  const clipped = []
  const seen = new Set()
  let turn = 0
  for (const m of parsed.messages) {
    if (m.role === "user") turn++
    if (m.role !== "assistant" || turn < from || turn > to) continue
    for (const t of m.tools) {
      if (!WEB_TOOLS.has(t.tool) || t.status !== "completed") continue
      const input = typeof t.input === "object" && t.input ? t.input : {}
      const key = t.tool === "webfetch" ? urlKey(input.url ?? "") : searchKey(input.query ?? "")
      if (CLIPPED.test(t.output ?? "")) clipped.push(`${t.tool} "${key}" in message ${m.index}`)
      if (seen.has(`${t.tool} ${key}`)) continue
      seen.add(`${t.tool} ${key}`)
      entries.push({ tool: t.tool, key, input, ...(t.title && { title: t.title }), output: t.output ?? "", turn })
    }
  }
  return { entries, clipped }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const args = process.argv.slice(2)
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"))
  const id = opt("--case")
  if (!file || !id) {
    console.error("usage: pnpm eval:record <export.md|export.json> --case <id> [--out <file>] [--turns 1-7]")
    process.exit(2)
  }
  const [from, to] = (opt("--turns") ?? "1-").split("-").map((x) => (x ? Number(x) : undefined))
  const L = await loadChecks()
  const src = readFileSync(file, "utf8")
  const parsed = L.parseTranscript(src)
  const { entries, clipped } = cassetteEntries(parsed, { from: from ?? 1, to: to ?? Infinity })
  if (clipped.length) {
    console.error(`Refused: ${clipped.length} tool output(s) in this export were shortened to fit the share size cap:\n  ${clipped.join("\n  ")}\nExport the chat again with \`pnpm chat:export <id> --json\` and record that.`)
    process.exit(1)
  }
  if (!entries.length) {
    console.error("No completed websearch/webfetch calls in that range; nothing to record.")
    process.exit(1)
  }
  const out = opt("--out") ?? path.join(ROOT, "scripts", "fixtures", "eval", "cassettes", `${id}.json`)
  const rel = path.relative(path.dirname(out), path.resolve(file)).replace(/\\/g, "/")
  const cassette = { format: "syrup.cassette", version: 1, case: id, source: { transcript: rel, recordedAt: new Date().toISOString().slice(0, 10) }, synthetic: false, entries }
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(cassette, null, 2)}\n`)
  const kb = Math.round(entries.reduce((n, e) => n + e.output.length, 0) / 1024)
  console.log(`[eval:record] ${entries.length} entries (${entries.map((e) => e.tool).join(", ")}), ${kb} KB of tool output → ${path.relative(ROOT, out)}`)
}
