#!/usr/bin/env node
/**
 * Turns an exported chat (syrup.transcript v1, Markdown or JSON) into the JSON `opencode import`
 * reads (the shape `opencode export` writes: { info, messages: [{ info, parts }] }), keeping user
 * turns 1..N only. `pnpm eval` imports it into its isolated engine and then sends turn N+1 live,
 * so a 7-question chat costs one turn of model requests, not seven (docs/QUALITY.md Q1; the format
 * was verified with OpenCode 1.18.32 in the Q0 spike).
 *
 *   node scripts/eval/seed.mjs <export> --turns 6 --dir <workspace> [--out seed.json] [--project global]
 *
 * What carries over: each user message's text, each assistant message's text and its completed
 * tool calls (input, output, title), in order. Reasoning, attachments and router metadata do not.
 * Times are moved so the last seeded message is a minute old: ids sort before the live turn's.
 */
import crypto from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** OpenCode's ascending ids: prefix_ + 12 hex digits of (ms × 0x1000 + counter) + 14 random base62 characters. */
function idMaker() {
  let counter = 0
  return (prefix, ms) => {
    const v = BigInt(Math.floor(ms)) * 0x1000n + BigInt(++counter)
    const hex = v.toString(16).padStart(12, "0").slice(-12)
    const rnd = Array.from(crypto.randomBytes(14), (b) => B62[b % 62]).join("")
    return `${prefix}_${hex}${rnd}`
  }
}

/** "2026-10-08 10:23:05 UTC" or an ISO string → epoch ms; undefined when it doesn't parse. */
function parseAt(at) {
  if (!at) return undefined
  const t = Date.parse(at.replace(" UTC", "Z").replace(" ", "T"))
  return Number.isFinite(t) ? t : undefined
}

/**
 * parsed: a ParsedTranscript (src/lib/answer-checks parseTranscript). Returns { data, sessionID,
 * messages: how many messages were seeded, lastUser: the first live user message's text (turn N+1) }.
 */
export function buildSeed(parsed, { turns, directory, projectID = "global", now = Date.now(), title }) {
  const id = idMaker()
  const keep = []
  let users = 0
  for (const m of parsed.messages) {
    if (m.role === "user") users++
    if (users > turns) break
    if (users === 0) continue
    keep.push(m)
  }
  if (users < turns) throw new Error(`the export has ${users} user turns, fewer than the ${turns} to seed`)
  const live = parsed.messages.filter((m) => m.role === "user")[turns]
  // Original spacing, moved so the last seeded message is a minute old; messages without a time get 5 s steps.
  const raw = keep.map((m) => parseAt(m.at))
  let prev
  const times = raw.map((t, i) => (prev = t ?? (prev ?? 0) + 5_000 * (i ? 1 : 0)))
  const shift = now - 60_000 - Math.max(...times)
  const at = (i) => times[i] + shift

  const sessionID = id("ses", at(0))
  const ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const messages = []
  let lastUser = null
  let call = 0
  keep.forEach((m, i) => {
    const created = at(i)
    const end = created + (m.meta?.tookMs ?? 1_000)
    const mid = id("msg", created)
    if (m.role === "user") {
      lastUser = mid
      messages.push({
        info: { id: mid, sessionID, role: "user", time: { created }, agent: "build", model: { providerID: "syrup", modelID: "auto" } },
        parts: [{ id: id("prt", created), sessionID, messageID: mid, type: "text", text: m.text }],
      })
      return
    }
    const tools = m.tools.filter((t) => t.status === "completed")
    const finish = tools.length && !m.text.trim() ? "tool-calls" : "stop"
    const parts = [{ id: id("prt", created), sessionID, messageID: mid, type: "step-start" }]
    for (const t of tools) {
      parts.push({
        id: id("prt", created),
        sessionID,
        messageID: mid,
        type: "tool",
        tool: t.tool,
        callID: `call_seed_${++call}`,
        state: { status: "completed", input: t.input ?? {}, output: t.output ?? "", title: t.title ?? "", metadata: {}, time: { start: created, end } },
      })
    }
    if (m.text.trim()) parts.push({ id: id("prt", created), sessionID, messageID: mid, type: "text", text: m.text, time: { start: created, end } })
    parts.push({ id: id("prt", end), sessionID, messageID: mid, type: "step-finish", reason: finish, cost: 0, tokens: ZERO })
    messages.push({
      info: {
        id: mid,
        sessionID,
        role: "assistant",
        parentID: lastUser,
        time: { created, completed: end },
        modelID: "auto",
        providerID: "syrup",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: ZERO,
        finish,
      },
      parts,
    })
  })
  const info = { id: sessionID, slug: "eval-seed", projectID, directory, title: title ?? parsed.title, version: "1.18.32", time: { created: at(0), updated: at(keep.length - 1) } }
  return { data: { info, messages }, sessionID, messages: keep.length, liveText: live?.text ?? null }
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2)
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"))
  if (!file || !opt("--turns") || !opt("--dir")) {
    console.error("usage: node scripts/eval/seed.mjs <export> --turns N --dir <workspace> [--out seed.json] [--project global]")
    process.exit(2)
  }
  const { loadChecks } = await import("./load-checks.mjs")
  const L = await loadChecks()
  const seed = buildSeed(L.parseTranscript(readFileSync(file, "utf8")), { turns: Number(opt("--turns")), directory: path.resolve(opt("--dir")), projectID: opt("--project") ?? "global" })
  const out = JSON.stringify(seed.data, null, 2)
  if (opt("--out")) {
    writeFileSync(opt("--out"), out)
    console.error(`[seed] ${seed.messages} messages, session ${seed.sessionID} → ${opt("--out")}; next live turn: ${JSON.stringify(seed.liveText)}`)
  } else process.stdout.write(out)
}
