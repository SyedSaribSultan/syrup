/**
 * Building blocks for UI harness scenarios (scripts/ui-harness.mjs, docs/TESTING.md).
 *
 * Every scenario plays in one fictional project, "acme-shop", on a Windows machine (the
 * founder's own setup), with the browser clock frozen at NOW so "2h ago" and "Running… 12s"
 * read the same on every run. The builders below produce sessions, messages and parts in
 * the shape OpenCode 1.18.32 returns through /api/oc: ids, time stamps, step-start /
 * step-finish around each step, tokens, patches, and each tool's title and output text
 * (checked against the running app and the engine's own tool code on 2026-10-07). Tool
 * metadata carries what the UI reads (bash output and exit, todos) plus `truncated`; the
 * rest (edit's filediff, grep's match count) is left out because nothing displays it yet.
 *
 *   const c = chat("Fix the cart rounding bug", { ago: 2 * HOUR })
 *   c.user("Some carts are off by a cent…")
 *   c.assistant([reasoning("…", { ms: 4200 }), tool("read", { filePath: abs("src/cart.ts") }, { output: "…" }), text("Fixed.")])
 *   export default defineScenario({ name: "my-screen", route: c.route, chats: [c, ...backgroundChats()] })
 *
 * Files starting with "_" in this folder are helpers, not scenarios.
 */
import { createHash } from "node:crypto"

// ---------------------------------------------------------------- time and place

export const SEC = 1000
export const MIN = 60 * SEC
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

/** The browser's Date.now() during every scenario (the harness freezes it with page.clock.setFixedTime). */
export const NOW = Date.parse("2026-10-07T09:30:00.000Z")

/** Local mode's Home workspace (~/syrup) and the project the scenarios work in. */
export const HOME = "C:\\Users\\dev\\syrup"
export const WORKSPACE = "C:\\Users\\dev\\code\\acme-shop"

/** A workspace file's absolute path, the way tools receive it on Windows: C:\Users\dev\code\acme-shop\src\cart.ts */
export function abs(rel, dir = WORKSPACE) {
  return `${dir}\\${rel.replace(/\//g, "\\")}`
}

/** The same path with forward slashes, the way patch parts spell it: C:/Users/dev/code/acme-shop/src/cart.ts */
export function slashed(rel, dir = WORKSPACE) {
  return abs(rel, dir).replace(/\\/g, "/")
}

/** Workspace-relative path with the OS separator, as tool titles show it: src\cart.ts */
export function rel(p) {
  return p.replace(/\//g, "\\")
}

// ---------------------------------------------------------------- ids

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** OpenCode-style ids (ses_…, msg_…, prt_…): 12 hex digits that sort by creation, then 14 stable pseudo-random characters. */
function makeIds(seed) {
  let n = 0
  return (prefix, at = 0) => {
    n++
    const hex = (Math.floor(at / 1000) * 4096 + n).toString(16).padStart(12, "0").slice(-12)
    const h = createHash("sha256").update(`${seed}:${prefix}:${n}`).digest()
    let tail = ""
    for (let i = 0; i < 14; i++) tail += BASE62[h[i] % 62]
    return `${prefix}_${hex}${tail}`
  }
}

const sha = (s) => createHash("sha1").update(s).digest("hex")

// ---------------------------------------------------------------- parts

/**
 * Part specs. Each takes `ms` (how long it took; for an open part, how long it has been running)
 * and `open` (still streaming: no end time). The chat builder adds ids, session and message ids and times.
 *
 * An open text or reasoning part is served empty, as the engine stores it, and the page loads it mid-stream:
 * it shows "Writing…" until the part's final update (`partEnd`). With `later: true` the part hasn't started
 * when the page opens: no read returns it until a step emits `partStart(part)`, and from then on its
 * `partDeltas` grow on screen, as for a page that watches a reply from its first word. `body` is the text
 * the part will have streamed (or, open without `later`, has streamed so far).
 */
export function text(body, { ms = 1500, open = false, later = false } = {}) {
  return { spec: "text", ms, open, later: open && later, part: { type: "text", text: body } }
}

export function reasoning(body, { ms = 3000, open = false, later = false } = {}) {
  return { spec: "reasoning", ms, open, later: open && later, part: { type: "reasoning", text: body, metadata: {} } }
}

/** Set on a `later` part in the scenario data; the harness serves no part carrying it (scripts/ui-harness.mjs LATER). */
const LATER = "__harnessStartsLater"

/** A part as the engine sends it, without the kit's marks. */
function enginePart(part) {
  const { [LATER]: _later, ...rest } = part
  void _later
  return structuredClone(rest)
}

/** The update OpenCode 1.18 sends when a text or reasoning part starts: the part, empty, with only a start time. */
export function partStart(part) {
  const p = enginePart(part)
  return { type: "message.part.updated", properties: { sessionID: p.sessionID, part: { ...p, text: "", time: { start: p.time?.start ?? NOW } }, time: p.time?.start ?? NOW } }
}

/** `text` as the message.part.delta events a model's stream arrives in, `size` code points each (no emoji cut in half). */
export function partDeltas(part, text = part.text, size = 24) {
  const cps = Array.from(text)
  const out = []
  for (let i = 0; i < cps.length; i += size) out.push({ type: "message.part.delta", properties: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id, field: "text", delta: cps.slice(i, i + size).join("") } })
  return out
}

/** The update that ends a streamed part: its whole text and an end time. The engine stores this; it is the part from now on. */
export function partEnd(part, { text = part.text, at = NOW } = {}) {
  const p = enginePart(part)
  return { type: "message.part.updated", properties: { sessionID: p.sessionID, part: { ...p, text, time: { start: p.time?.start ?? at, end: at } }, time: at } }
}

/** The open text or reasoning parts of a scenario's chat, in order (to stream them in steps). */
export function openParts(scenario, sessionID) {
  return (scenario.engine.messages[sessionID] ?? []).flatMap((m) => m.parts).filter((p) => (p.type === "text" || p.type === "reasoning") && p.time && p.time.end === undefined)
}

/**
 * A tool call, in the states OpenCode 1.18 stores:
 * - "pending": the model is still writing the call's input (`input: {}`).
 * - "running": input and start time only. A tool that reports progress adds `metadata`
 *   (bash streams `{ output }`); none sets a title while running, so the row shows the input.
 * - "completed" (default): `output`, a `title` (what OpenCode sets: the relative path for
 *   file tools, the command for bash, the pattern for grep, "N todos" for todowrite) and
 *   `metadata`, which always carries `truncated`.
 * - "error": the thrown message in `error`, e.g. edit's "Could not find oldString in the file. …".
 */
export function tool(name, input, { status = "completed", output = "", error = "", title, metadata, ms = 900 } = {}) {
  let state
  if (status === "pending") state = { status, input: {}, raw: "" }
  else if (status === "running") state = { status, input, ...(title !== undefined ? { title } : {}), ...(metadata ? { metadata } : {}) }
  else if (status === "error") state = { status, input, error, ...(metadata ? { metadata } : {}) }
  else state = { status, input, output, title: title ?? defaultTitle(name, input), metadata: { ...metadata, truncated: metadata?.truncated ?? false } }
  return { spec: "tool", ms, open: status === "running" || status === "pending", part: { type: "tool", callID: "", tool: name, state } }
}

function defaultTitle(name, input) {
  if (name === "bash") return input?.command ?? ""
  if (name === "todowrite") return `${(input?.todos ?? []).filter((t) => t.status !== "completed").length} todos`
  const p = input?.filePath ?? input?.path
  const relative = (x) => (x.startsWith(WORKSPACE) ? rel(x.slice(WORKSPACE.length + 1)) : x)
  // glob's title is the folder it searched, relative to the project: "" for the project itself.
  if (name === "glob") return typeof p === "string" ? relative(p) : ""
  if (typeof p === "string") return relative(p)
  return input?.pattern ?? input?.url ?? ""
}

/**
 * A read call's `output` and `metadata`, exactly as OpenCode 1.18.32 writes them:
 *   <path>C:\…\src\cart.ts</path> / <type>file</type> / <content> / "1: line" … / (End of file - total N lines) / </content>
 * With `limit`, a partial read ends in "(Showing lines 1-3 of 25. Use offset=4 to continue.)".
 *   tool("read", { filePath: abs("src/cart.ts") }, { ...readResult("src/cart.ts", SOURCES.cartBefore), ms: 200 })
 */
export function readResult(relPath, content, { offset = 1, limit = 2000, dir = WORKSPACE } = {}) {
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const shown = lines.slice(offset - 1, offset - 1 + limit)
  const last = offset + shown.length - 1
  const more = offset - 1 + shown.length < lines.length
  const file = abs(relPath, dir)
  const output = [
    `<path>${file}</path>`,
    "<type>file</type>",
    "<content>",
    shown.map((l, i) => `${i + offset}: ${l}`).join("\n"),
    "",
    more ? `(Showing lines ${offset}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)` : `(End of file - total ${lines.length} lines)`,
    "</content>",
  ].join("\n")
  const display = { type: "file", path: file, text: shown.join("\n"), lineStart: offset, lineEnd: last, totalLines: lines.length, truncated: more }
  return { output, metadata: { preview: shown.slice(0, 20).join("\n"), truncated: more, loaded: [], display } }
}

/** The note OpenCode 1.18 appends when it stops a command at its timeout. The call still completes (exit null); it is not an error. */
export const BASH_TIMEOUT_NOTE = (ms) =>
  `<shell_metadata>\nshell tool terminated command after exceeding timeout ${ms} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.\n</shell_metadata>`

/**
 * A bash call's `output` and `metadata` as OpenCode 1.18.32 writes them: the command's output
 * ("(no output)" when empty), and with `timeoutMs` the timeout note and `exit: null`.
 *   tool("bash", { command: "pnpm test", description: "Run the tests" }, { ...bashResult("…", { timeoutMs: 120_000 }), ms: 120 * SEC })
 */
export function bashResult(stdout, { exit = 0, timeoutMs } = {}) {
  let output = stdout || "(no output)"
  if (timeoutMs) output += `\n\n${BASH_TIMEOUT_NOTE(timeoutMs)}`
  return { output, metadata: { output: stdout || output, exit: timeoutMs ? null : exit, truncated: false } }
}

/** Files the step changed, as absolute paths with forward slashes (what the engine sends). */
export function patch(files) {
  return { spec: "patch", ms: 0, open: false, part: { type: "patch", hash: "", files } }
}

export function file({ filename, mime, url }) {
  return { spec: "file", ms: 0, open: false, part: { type: "file", mime, filename, url } }
}

// ---------------------------------------------------------------- chats

/**
 * A user message's summary.diffs entry, as OpenCode writes it: one full-context hunk per file
 * (every line, marked " ", "-" or "+" by a minimal line diff), with its addition and deletion counts.
 */
export function diff(path, before, after, status = before ? "modified" : "added") {
  const a = before ? before.split("\n") : []
  const b = after.split("\n")
  // Longest common subsequence table, then a walk from the start: small files only, which is all a fixture has.
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const body = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      body.push(` ${a[i]}`)
      i++
      j++
    } else if (i < a.length && (j === b.length || L[i + 1][j] >= L[i][j + 1])) body.push(`-${a[i++]}`)
    else body.push(`+${b[j++]}`)
  }
  const head = [`Index: ${path}`, "===================================================================", `--- ${path}\t`, `+++ ${path}\t`, `@@ -${a.length ? 1 : 0},${a.length} +1,${b.length} @@`]
  const additions = body.filter((l) => l[0] === "+").length
  const deletions = body.filter((l) => l[0] === "-").length
  return { file: path, patch: `${[...head, ...body].join("\n")}\n`, additions, deletions, status }
}

const ROUTED_DEFAULT = "google/gemini-3.5-flash"

/**
 * One chat. `ago`: how long before NOW its last activity was (0 for a chat that is still working).
 * Messages are laid out in order with realistic gaps, then shifted so the last moment lands on NOW - ago.
 */
export function chat(title, { ago = 0, directory = WORKSPACE, model = "auto", routed = ROUTED_DEFAULT, id } = {}) {
  const ids = makeIds(`${directory}|${title}`)
  const sessionID = id ?? ids("ses", NOW - ago)
  const steps = []
  let busy = false

  const c = {
    id: sessionID,
    title,
    directory,
    route: `/s/${sessionID}`,
    /** A user message. `after`: the pause since the previous message. `diffs`: what the turn changed (summary.diffs). */
    user(body, { after = 25 * SEC, diffs, files = [] } = {}) {
      steps.push({ role: "user", body, after, diffs, files })
      return c
    },
    /**
     * An assistant message: one engine step. `open`: still streaming (no completed time, no step-finish).
     * `routed`: "provider/model" the router answered with; `ttft`: its time to first token.
     */
    assistant(parts, { open = false, routed: r = routed, ttft = 900, tokens, after = 400 } = {}) {
      steps.push({ role: "assistant", parts, open, routed: r, ttft, tokens, after })
      if (open) busy = true
      return c
    },
    /** Marks the session busy even when its last message is closed (e.g. waiting for the next step). */
    busy() {
      busy = true
      return c
    },
    build() {
      return buildChat({ sessionID, title, directory, model, ago, steps, busy, ids })
    },
  }
  return c
}

function buildChat({ sessionID, title, directory, model, ago, steps, busy, ids }) {
  // Lay out on a relative clock, then shift so the last moment is NOW - ago.
  let t = 0
  const laid = []
  for (const s of steps) {
    t += s.after
    if (s.role === "user") {
      laid.push({ ...s, created: t })
      t += 200
      continue
    }
    const created = t
    t += 150
    const parts = []
    for (const p of s.parts) {
      const start = t
      t += p.ms
      parts.push({ ...p, start, end: p.open ? undefined : t })
      t += p.open ? 0 : 60
    }
    laid.push({ ...s, created, parts, completed: s.open ? undefined : t + 80 })
    t += s.open ? 0 : 80
  }
  const shift = NOW - ago - t
  const at = (x) => (x === undefined ? undefined : Math.round(x + shift))

  const messages = []
  const answers = []
  // The router's row for a step still streaming: the harness adds it when a step emits the message's completion.
  const pendingAnswers = []
  let parentID = ""
  let lastAt = NOW - ago
  let turn = 0
  for (const s of laid) {
    const created = at(s.created)
    if (s.role === "user") {
      const msgID = ids("msg", created)
      parentID = msgID
      const info = { id: msgID, sessionID, role: "user", time: { created }, ...(s.diffs ? { summary: { diffs: s.diffs } } : {}), agent: "build", model: { providerID: "syrup", modelID: model } }
      const parts = [{ type: "text", text: s.body }, ...s.files.map((f) => ({ type: "file", ...f }))].map((p) => ({ id: ids("prt", created), sessionID, messageID: msgID, ...p }))
      messages.push({ info, parts })
      turn++
      continue
    }
    const msgID = ids("msg", created)
    const snapshot = sha(`${sessionID}:${msgID}:start`)
    // [time, part] pairs in the order the engine sends them: step-start, the parts, step-finish, then the patch.
    const body = [[created, { type: "step-start", snapshot }]]
    const tail = []
    let chars = 0
    let toolCalls = 0
    for (const p of s.parts) {
      const part = structuredClone(p.part)
      const time = { start: at(p.start), ...(p.end !== undefined ? { end: at(p.end) } : {}) }
      if (part.type === "text" || part.type === "reasoning") {
        chars += part.text.length
        part.time = time
        if (p.later) part[LATER] = true
      }
      if (part.type === "tool") {
        toolCalls++
        if (part.state.status !== "pending") part.state.time = time
      }
      if (part.type === "patch") tail.push([at(p.start), { ...part, hash: snapshot }])
      else body.push([at(p.start), part])
    }
    const out = Math.ceil(chars / 4) + toolCalls * 45
    const input = 8200 + turn * 1900 + messages.length * 350
    const tokens = s.tokens ?? { total: input + out, input, output: out, reasoning: 0, cache: { read: Math.round(input * 0.55), write: 0 } }
    const completed = at(s.completed)
    const finish = toolCalls && !chars ? "tool-calls" : "stop"
    if (completed) body.push([completed, { type: "step-finish", reason: finish, snapshot: sha(`${msgID}:end`), cost: 0, tokens }])
    // Ids ascend in array order, as the engine's do (it sorts parts by id).
    let clock = created
    const parts = [...body, ...tail].map(([t, part]) => {
      clock = Math.max(clock, t)
      const id = ids("prt", clock)
      if (part.type === "tool") part.callID = `call_${createHash("sha1").update(id).digest("hex").slice(0, 6)}`
      return { id, sessionID, messageID: msgID, ...part }
    })
    const info = {
      id: msgID,
      sessionID,
      role: "assistant",
      time: { created, ...(completed ? { completed } : {}) },
      parentID,
      modelID: model,
      providerID: "syrup",
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens,
      ...(completed ? { finish } : {}),
    }
    messages.push({ info, parts })
    lastAt = completed ?? lastAt
    // The router's row for this step, written when the request ends (GET /api/router/answers).
    if (completed && s.routed) {
      const [providerId, ...rest] = s.routed.split("/")
      const ts = completed - 40
      answers.push({ ts, alias: model, providerId, modelId: rest.join("/"), ttftMs: s.ttft, latencyMs: ts - (created + 120), attempts: 1, reason: answers.length ? "sticky" : "best", inputTokens: tokens.input, partial: false })
    } else if (s.routed) {
      const [providerId, ...rest] = s.routed.split("/")
      pendingAnswers.push({ messageID: msgID, created, alias: model, providerId, modelId: rest.join("/"), ttftMs: s.ttft, attempts: 1, reason: answers.length ? "sticky" : "best", inputTokens: tokens.input, partial: false })
    }
  }

  const first = messages[0]?.info.time.created ?? NOW - ago
  const session = {
    id: sessionID,
    slug: slugOf(title),
    projectID: directory === HOME ? "global" : sha(directory),
    directory,
    path: directory.replace(/^[a-z]:\\/i, "").replace(/\\/g, "/"),
    summary: { additions: 0, deletions: 0, files: 0 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title,
    agent: "build",
    model: { id: model, providerID: "syrup", variant: "default" },
    version: "1.18.32",
    time: { created: first - 300, updated: Math.max(lastAt, ...messages.map((m) => m.info.time.created)) },
  }
  return { session, messages, status: busy ? { type: "busy" } : { type: "idle" }, answers, pendingAnswers }
}

function slugOf(title) {
  const words = ["gentle", "quiet", "bright", "amber", "swift", "calm", "maple", "river", "meadow", "ember", "harbor", "willow"]
  const h = createHash("sha1").update(title).digest()
  return `${words[h[0] % words.length]}-${words[h[1] % words.length]}`
}

/** Chats that only fill the sidebar: a session row each, no messages. */
export function backgroundChats() {
  return [
    chat("Add dark mode to the storefront", { ago: 3 * HOUR }),
    chat("Why is the product grid slow on phones?", { ago: 26 * HOUR }),
    chat("Set up Playwright for checkout", { ago: 3 * DAY }),
    chat("Rename SKU fields to camelCase", { ago: 5 * DAY }),
    chat("Plan the autumn sale banner", { ago: 2 * DAY, directory: HOME }),
  ]
}

// ---------------------------------------------------------------- engine defaults

function model(providerID, id, name, { cost = [0, 0], context = 1_048_576, output = 65_536, reasoning = false, attachment = false, family = "", released = "" } = {}) {
  return {
    id,
    providerID,
    api: { id, url: "", npm: providerID === "google" ? "@ai-sdk/google" : "@ai-sdk/openai-compatible" },
    name,
    family,
    capabilities: {
      temperature: providerID !== "syrup",
      reasoning,
      attachment,
      toolcall: true,
      input: { text: true, audio: false, image: attachment, video: false, pdf: attachment },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: cost[0], output: cost[1], cache: { read: cost[0] / 10, write: 0 } },
    limit: { context, output },
    status: "active",
    options: {},
    headers: {},
    release_date: released,
    variants: {},
  }
}

/** GET /api/oc/config/providers: the router aliases, a free Google key, OpenCode's built-in free model. */
export const PROVIDERS = {
  providers: [
    {
      id: "syrup",
      name: "syrup",
      source: "config",
      env: [],
      options: { baseURL: "http://127.0.0.1:4210/v1", apiKey: "fixture-not-a-secret", timeout: 600000 },
      models: {
        auto: model("syrup", "auto", "Auto", { context: 256_000, output: 32_000 }),
        fast: model("syrup", "fast", "Fast", { context: 256_000, output: 32_000 }),
      },
    },
    {
      id: "google",
      name: "Google",
      source: "api",
      env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
      options: {},
      models: {
        "gemini-3.5-flash": model("google", "gemini-3.5-flash", "Gemini 3.5 Flash", { cost: [0.3, 2.5], reasoning: true, attachment: true, family: "gemini-flash", released: "2026-06-17" }),
        "gemini-3.5-flash-lite": model("google", "gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", { cost: [0.1, 0.4], attachment: true, family: "gemini-flash-lite", released: "2026-06-17" }),
        "gemini-3.1-pro-preview": model("google", "gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", { cost: [2, 12], reasoning: true, attachment: true, family: "gemini-pro", released: "2026-04-02" }),
      },
    },
    {
      id: "opencode",
      name: "OpenCode Zen",
      source: "custom",
      env: ["OPENCODE_API_KEY"],
      options: {},
      models: { "big-pickle": model("opencode", "big-pickle", "Big Pickle", { context: 200_000, output: 32_000 }) },
    },
  ],
  default: { syrup: "fast", google: "gemini-3.5-flash", opencode: "big-pickle" },
}

/** GET /api/providers (syrup's own key list): one free Google key, the rest not connected. */
export const KEYS = {
  providers: [
    {
      id: "google",
      name: "Google",
      connected: true,
      routable: true,
      env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
      keys: [{ id: "key_fixture0google", label: "AI Studio", tier: "free", hint: "x7Qk", active: true, createdAt: NOW - 30 * DAY }],
      curated: { rank: 1, keyUrl: "https://aistudio.google.com/apikey", note: "Best free quality.", freeTier: true, trainsOnData: true },
    },
    { id: "openrouter", name: "OpenRouter", connected: false, routable: true, env: ["OPENROUTER_API_KEY"], keys: [], curated: { rank: 3, keyUrl: "https://openrouter.ai/settings/keys", note: "One key, many free models.", freeTier: true } },
    { id: "groq", name: "Groq", connected: false, routable: true, env: ["GROQ_API_KEY"], keys: [], curated: { rank: 7, keyUrl: "https://console.groq.com/keys", note: "Very fast, small free tier.", freeTier: true } },
    { id: "syrup", name: "syrup", connected: true, routable: false, env: [], keys: [] },
    { id: "opencode", name: "OpenCode Zen", connected: true, routable: false, env: ["OPENCODE_API_KEY"], keys: [] },
  ],
  default: { google: "gemini-3.5-flash", openrouter: "openrouter/auto", groq: "llama-3.3-70b-versatile", syrup: "fast", opencode: "big-pickle" },
}

/** GET /api/router/status: both aliases healthy on Google. */
export const ROUTER = {
  at: NOW,
  backends: [
    { providerId: "google", modelId: "gemini-3.5-flash", coolingUntil: null, coolReason: null, ttftMs: 910, okRate: 0.97, lastUsed: NOW - 2 * MIN },
    { providerId: "google", modelId: "gemini-3.5-flash-lite", coolingUntil: null, coolReason: null, ttftMs: 640, okRate: 0.99, lastUsed: NOW - 6 * MIN },
  ],
  aliases: { auto: { providerId: "google", modelId: "gemini-3.5-flash", at: NOW - 2 * MIN }, fast: { providerId: "google", modelId: "gemini-3.5-flash-lite", at: NOW - 6 * MIN } },
  authFailures: [],
  keyCooldowns: [],
}

// ---------------------------------------------------------------- the workspace's files

const CART_BEFORE = `import type { LineItem } from "./types"

export function cartTotal(items: LineItem[], taxRate: number): number {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0)
  const tax = subtotal * taxRate
  return Number((subtotal + tax).toFixed(2))
}`

const CART_AFTER = `import type { LineItem } from "./types"
import { roundCents, toCents } from "./money"

/** Totals in integer cents: floats only touch the tax line, rounded once. */
export function cartTotal(items: LineItem[], taxRate: number): number {
  const subtotal = items.reduce((sum, i) => sum + toCents(i.price) * i.qty, 0)
  return (subtotal + roundCents(subtotal * taxRate)) / 100
}`

const MONEY = `/** Money helpers: prices are dollars in the catalog, cents everywhere else. */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100)
}

/** Half-up rounding to a whole cent, the way the payment provider rounds. */
export function roundCents(cents: number): number {
  return Math.floor(cents + 0.5)
}`

export const SOURCES = { cartBefore: CART_BEFORE, cartAfter: CART_AFTER, money: MONEY }

const ORDERS_CSV = `order_id,placed_at,customer,country,items,subtotal_usd,tax_usd,total_usd,status,payment
1041,2026-09-28 08:12,Maya Okafor,US,3,59.97,4.95,64.92,paid,card
1042,2026-09-28 09:47,Lukas Berg,DE,1,24.00,4.56,28.56,paid,paypal
1043,2026-09-28 11:03,Sofia Marino,IT,2,41.50,9.13,50.63,refunded,card
1044,2026-09-28 13:26,"Chen, Wei",SG,5,112.25,10.10,122.35,paid,card
1045,2026-09-29 07:58,Amara Diallo,FR,1,19.99,4.00,23.99,paid,apple_pay
1046,2026-09-29 10:14,Noah Fischer,AT,4,87.60,17.52,105.12,paid,card
1047,2026-09-29 12:40,Isabel Cruz,ES,2,38.00,7.98,45.98,pending,bank_transfer
1048,2026-09-29 16:05,Tom Halvorsen,NO,6,143.70,35.93,179.63,paid,card
1049,2026-09-30 08:31,Priya Raman,IN,1,12.50,2.25,14.75,paid,upi
1050,2026-09-30 09:52,Jonas Weber,CH,3,66.30,5.37,71.67,paid,card
1051,2026-09-30 14:18,Grace Kim,KR,2,45.80,4.58,50.38,cancelled,card
1052,2026-10-01 07:44,Liam O'Connor,IE,1,29.00,6.67,35.67,paid,card
1053,2026-10-01 10:09,Elena Petrova,BG,7,158.40,31.68,190.08,paid,paypal
1054,2026-10-01 15:37,Mateo Silva,PT,2,34.98,8.05,43.03,paid,card
1055,2026-10-02 08:20,Hannah Schulz,DE,3,71.25,13.54,84.79,paid,apple_pay
1056,2026-10-02 11:55,Kwame Mensah,GH,1,18.00,2.70,20.70,pending,card
1057,2026-10-02 13:02,Zoe Laurent,BE,4,92.10,19.34,111.44,paid,card
1058,2026-10-03 09:28,Arjun Mehta,US,2,47.50,3.92,51.42,paid,card
1059,2026-10-03 12:16,Freya Nilsson,SE,5,119.95,29.99,149.94,paid,klarna
1060,2026-10-03 17:41,Daniel Rossi,IT,1,22.40,4.93,27.33,refunded,card
1061,2026-10-04 08:05,Aiko Tanaka,JP,3,64.80,6.48,71.28,paid,card
1062,2026-10-04 10:33,Oliver Smith,GB,2,39.98,8.00,47.98,paid,paypal
1063,2026-10-04 14:59,Lucia Gomez,MX,6,131.70,21.07,152.77,paid,card
1064,2026-10-05 09:12,Ethan Brown,CA,1,15.99,2.08,18.07,paid,card
`

const LAUNCH_PLAN = `# Launch plan: acme-shop 1.0

**Target date:** Tuesday 20 October 2026 · **Owner:** Maya · **Status:** on track

We open the store to everyone on the mailing list first, then to the public a day later.
This page is the single source of truth; the chat links here.

## Checklist

- [x] Fix the one-cent rounding error at checkout (\`src/cart.ts\`)
- [x] Product photos for all 48 SKUs
- [ ] Stripe live keys and the webhook endpoint
- [ ] Apple Pay domain verification
- [ ] Shipping rates for the EU and the UK
- [ ] Launch email and social posts

## Who does what

| Area | Owner | Due | Notes |
| --- | --- | --- | --- |
| Payments | Maya | 14 Oct | Live keys, webhook, Apple Pay |
| Catalog | Lukas | 12 Oct | Photos done; copy review left |
| Shipping | Sofia | 15 Oct | EU and UK rates, free over $75 |
| Marketing | Amara | 18 Oct | Email, two social posts, banner |

## Payments

Stripe handles cards, Apple Pay and Google Pay through the Payment Element.
The webhook marks an order paid only after \`payment_intent.succeeded\`.

\`\`\`bash
# .env.production (values live in Vercel, never in git)
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
NEXT_PUBLIC_STRIPE_KEY=pk_live_…
\`\`\`

> Apple Pay only shows on HTTPS. Test it on the preview deployment, not on localhost.

## Risks

1. **Webhook delays.** If Stripe is slow, orders stay "pending" for a few minutes. The order page says so.
2. **Stock counts.** The catalog is updated by hand; we freeze edits 24 hours before launch.
3. **Tax rules.** EU VAT is included in prices; the US adds sales tax at checkout.

Reference: [Stripe Payment Element](https://docs.stripe.com/payments/payment-element) · [Apple Pay setup](https://docs.stripe.com/apple-pay)
`

/** The project's files, for the Files and Preview tabs (workspace-relative, forward slashes). */
export const WORKSPACE_FILES = {
  "README.md": "# acme-shop\n\nA small storefront: product grid, cart and Stripe checkout.\n\n## Develop\n\n```bash\npnpm install\npnpm dev\n```\n",
  "package.json": `${JSON.stringify({ name: "acme-shop", private: true, scripts: { dev: "next dev", build: "next build", test: "vitest" }, dependencies: { next: "16.3.5", react: "19.2.8", stripe: "^19.2.0" }, devDependencies: { vitest: "^4.1.0" } }, null, 2)}\n`,
  "src/cart.ts": `${CART_AFTER}\n`,
  "src/money.ts": `${MONEY}\n`,
  "src/types.ts": "export type LineItem = { sku: string; price: number; qty: number }\n",
  "src/cart.test.ts": `import { describe, expect, it } from "vitest"\nimport { cartTotal } from "./cart"\n\ndescribe("cartTotal", () => {\n  it("rounds 3 × $19.99 at 8.25% to the cent", () => {\n    expect(cartTotal([{ sku: "mug", price: 19.99, qty: 3 }], 0.0825)).toBe(64.92)\n  })\n})\n`,
  "docs/launch-plan.md": LAUNCH_PLAN,
  "data/orders.csv": ORDERS_CSV,
}

// ---------------------------------------------------------------- scenarios

/**
 * Turns builder chats into the plain data the harness serves, and fills engine defaults.
 * A scenario may also give `engine` directly (sessions, messages, status, answers…); see docs/TESTING.md.
 */
export function defineScenario(s) {
  const built = (s.chats ?? []).map((c) => (typeof c.build === "function" ? c.build() : c))
  const engine = { ...(s.engine ?? {}) }
  engine.directory ??= WORKSPACE
  engine.home ??= HOME
  engine.sessions = [...(engine.sessions ?? []), ...built.map((b) => b.session)]
  engine.messages = { ...(engine.messages ?? {}) }
  engine.status = { ...(engine.status ?? {}) }
  engine.answers = { ...(engine.answers ?? {}) }
  engine.pendingAnswers = { ...(engine.pendingAnswers ?? {}) }
  for (const b of built) {
    if (b.messages.length) engine.messages[b.session.id] = b.messages
    if (b.status.type !== "idle") engine.status[b.session.id] = b.status
    if (b.answers.length) engine.answers[b.session.id] = b.answers
    if (b.pendingAnswers.length) engine.pendingAnswers[b.session.id] = b.pendingAnswers
  }
  engine.providers ??= PROVIDERS
  engine.keys ??= KEYS
  engine.router ??= ROUTER
  engine.now ??= NOW
  const { chats, ...rest } = s
  void chats
  return { ...rest, engine }
}
