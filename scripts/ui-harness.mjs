#!/usr/bin/env node
/**
 * UI harness: renders fixture scenarios in the running local app and checks them
 * (docs/TESTING.md, the per-round gate in docs/ROADMAP.md §2). Real models are slow
 * and never say the same thing twice, so the engine is faked in the browser:
 * Playwright answers everything the page asks of /api/oc/** (path, projects,
 * providers, sessions, messages, status, permissions, questions, files), the
 * router views, the workspace file API and the other local routes a chat screen
 * calls, from scenario modules in scripts/fixtures/ui/. The event stream is a
 * real, open SSE response from a small server inside this process, so the page
 * stays "connected" and a step can push more events. Nothing reaches the real
 * engine, the host's file manager or analytics. The fake follows OpenCode 1.18.32
 * where the UI can tell: a streaming text part is stored empty and its text arrives
 * as message.part.delta events; the stream replays nothing when it opens, so the page
 * learns busy sessions and pending permissions and questions by asking for them; events
 * a step emits change what later reads return, as they would in the engine.
 *
 *   pnpm dev                                           # in another terminal (or any running local syrup)
 *   pnpm ui:harness                                    # every scenario at 390 and 1440 px → screenshots/harness/latest/
 *   pnpm ui:harness --label round-2                    # → screenshots/harness/round-2/
 *   pnpm ui:harness --only chat-streaming,new-chat     # some scenarios
 *   pnpm ui:harness --widths 390 --headed              # one width, in a visible browser
 *   pnpm ui:harness --list                             # what each scenario shows
 *
 * Per scenario and width it writes <scenario>-<width>.png (the viewport) and, when the
 * chat or panel scrolls, <scenario>-<width>-full.png (the viewport grown to fit it), and
 * records console errors, page errors, layout problems (sideways overflow of the page, chat
 * column, panel or key controls against the device width, and a chat column squeezed under
 * 280 px; measured in the local layout and again in the hosted one) and the scenario's assertions. An assertion with a `gap` note is a known app
 * gap: it must fail (and is listed), and the run fails once it passes. A run that fails
 * while the dev server pushes an update (someone saved a file in the app) is run again, up
 * to twice. Prints a table, writes report.json next to the screenshots, and exits 1 on any
 * failure (2 if the app isn't running).
 *
 * Flags: --label <name> (default latest) · --only <a,b> · --widths <390,1440> · --base <url>
 * (default http://127.0.0.1:3000, env UI_HARNESS_BASE) · --scale <n> (device pixel ratio,
 * default 1) · --no-full · --cloud-frame (take the screenshots in the hosted /w/… layout too;
 * its overflow is checked on every run anyway) · --browser webkit (Safari's engine; phone
 * layout has differed between engines before) · --headed · --list · --dir <folder> (load the
 * scenarios from another folder, to try one out without adding it to the repo)
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chromium, webkit } from "playwright"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const SCENARIO_DIR = path.join(ROOT, "scripts", "fixtures", "ui")
const DEFAULT_BASE = "http://127.0.0.1:3000"

/** Hidden in screenshots only: the Next.js dev-tools badge. Errors it would show are recorded as console/page errors. */
const SCREENSHOT_CSS = "nextjs-portal { display: none !important; }"

/**
 * The hosted layout chain: /w/… pages put the AppShell inside a flex row (src/components/cloud-frame.tsx), so it
 * is a flex item there and a block child of <body> here. Phone overflow bugs have been cloud-only for that reason
 * (an AppShell root without min-w-0 grew to the chat's widest line); making <body> the flex row reproduces the
 * cloud chain without moving React's nodes. Every run measures overflow with it; --cloud-frame also shoots with it.
 */
const CLOUD_FRAME_CSS = "body { display: flex; }"

/**
 * Console errors that are expected and say nothing about the screen under test. Keep this short and give
 * every entry its reason; a match is listed under "Notes" in the summary instead of failing the run.
 */
const KNOWN_CONSOLE = [
  {
    match: /^Viewport argument key "interactive-widget" not recognized and ignored\.$/,
    why: "src/app/layout.tsx sets interactive-widget for Android's keyboard on purpose; WebKit (Safari) ignores the key and says so",
  },
]

// ---------------------------------------------------------------- scenarios

/**
 * Every scenario module in scripts/fixtures/ui, or in `dir` (--dir, for a scenario you are trying out
 * without adding it to the repo). Files starting with "_" are helpers. A module exports one scenario or an array of variants.
 */
export async function loadScenarios(only = [], dir = SCENARIO_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    .sort()
  const all = []
  for (const f of files) {
    const full = path.join(dir, f)
    const mod = await import(pathToFileURL(full).href)
    const list = Array.isArray(mod.default) ? mod.default : [mod.default]
    // Repo-relative when the module is in the repo, so messages can name it short.
    const rel = path.relative(ROOT, full)
    const file = rel.startsWith("..") || path.isAbsolute(rel) ? full : rel
    for (const s of list) {
      const problem = validate(s)
      if (problem) throw new Error(`${f}: ${problem}`)
      if (all.some((x) => x.name === s.name)) throw new Error(`${f}: duplicate scenario name "${s.name}"`)
      all.push({ ...s, file })
    }
  }
  if (!only.length) return all
  const unknown = only.filter((n) => !all.some((s) => s.name === n))
  if (unknown.length) throw new Error(`No scenario named ${unknown.join(", ")}. Known: ${all.map((s) => s.name).join(", ")}`)
  return all.filter((s) => only.includes(s.name))
}

function validate(s) {
  if (!s || typeof s !== "object") return "default export must be a scenario (defineScenario({...})) or an array of them"
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s.name ?? "")) return `name must be kebab-case, got ${JSON.stringify(s.name)}`
  if (typeof s.route !== "string" || !s.route.startsWith("/")) return `${s.name}: route must start with "/"`
  if (!s.engine || typeof s.engine.directory !== "string") return `${s.name}: engine.directory is missing (use defineScenario from _kit.mjs)`
  if (s.block !== undefined && !(Array.isArray(s.block) && s.block.every((g) => typeof g === "string" && g))) return `${s.name}: block must be a list of URL globs`
  for (const step of s.steps ?? []) if (!STEP_KINDS.some((k) => k in step)) return `${s.name}: unknown step ${JSON.stringify(step).slice(0, 200)}`
  for (const a of [...(s.assert ?? []), ...(s.steps ?? []).filter((x) => "assert" in x).map((x) => x.assert)]) {
    if (!a || !ASSERT_KINDS.some((k) => k in a)) return `${s.name}: unknown assertion ${JSON.stringify(a)}`
    if ("gap" in a && !(typeof a.gap === "string" && a.gap.trim())) return `${s.name}: an assertion's gap must say, in words, why it fails today`
  }
  return null
}

// ---------------------------------------------------------------- devices

/** 390: a phone (touch, like scripts/shots.mjs). Below 1200: a tablet. From 1200: a desktop with a mouse. */
export function deviceFor(width, scale = 1) {
  const touch = width < 1200
  const height = width <= 480 ? 844 : touch ? 1133 : 900
  return { viewport: { width, height }, isMobile: touch, hasTouch: touch, deviceScaleFactor: scale }
}

// ---------------------------------------------------------------- the event stream

/**
 * A local SSE server for /api/oc/event. The page's request is handed here with route.continue({ url }),
 * which the page can't see (its URL stays /api/oc/event), and the response stays open like the real
 * engine's, so the client's reconnect loop never runs and the sidebar shows "Connected to engine".
 */
export async function startEventServer() {
  const channels = new Map()
  let seq = 0
  const frame = (ev) => `data: ${JSON.stringify({ id: `evt_${(++seq).toString(16).padStart(12, "0")}harness`, ...ev })}\n\n`
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x")
    const ch = channels.get(u.pathname.split("/")[2] ?? "")
    if (!ch) {
      res.writeHead(404).end()
      return
    }
    // WebKit treats the rewritten request as cross-origin (Chromium doesn't), so allow the app's origin.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "access-control-allow-origin": req.headers.origin ?? "*" })
    res.write(frame({ type: "server.connected", properties: {} }))
    for (const ev of ch.initial(u.searchParams.get("directory") ?? "")) res.write(frame(ev))
    ch.clients.add(res)
    req.on("close", () => ch.clients.delete(res))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  // Every 10 s, like the engine: a server.heartbeat event (the client ignores it).
  const ping = setInterval(() => {
    for (const ch of channels.values()) for (const res of ch.clients) res.write(frame({ type: "server.heartbeat", properties: {} }))
  }, 10_000)
  return {
    origin,
    open(channel, initial) {
      channels.set(channel, { clients: new Set(), initial })
    },
    url: (channel, search) => `${origin}/sse/${channel}${search}`,
    push(channel, events) {
      const ch = channels.get(channel)
      for (const res of ch?.clients ?? []) for (const ev of events) res.write(frame(ev))
      return ch?.clients.size ?? 0
    },
    /** How many pages hold this channel's stream open. */
    clients: (channel) => channels.get(channel)?.clients.size ?? 0,
    drop(channel) {
      const ch = channels.get(channel)
      for (const res of ch?.clients ?? []) res.end()
      channels.delete(channel)
    },
    close() {
      clearInterval(ping)
      for (const ch of channels.values()) for (const res of ch.clients) res.end()
      server.closeAllConnections?.()
      server.close()
    },
  }
}

// ---------------------------------------------------------------- the fake engine

/** Folder paths compare case-insensitively on Windows and ignore slash style (src/lib/workspaces.tsx samePath). */
function samePath(a, b) {
  const n = (p) => {
    const s = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[a-z]:/i.test(s) ? s.toLowerCase() : s
  }
  return n(a) === n(b)
}

const isWin = (dir) => /^[a-z]:[\\/]/i.test(dir) || dir.includes("\\")
const joinAbs = (dir, rel) => (rel ? `${dir.replace(/[\\/]+$/, "")}${isWin(dir) ? "\\" : "/"}${isWin(dir) ? rel.replace(/\//g, "\\") : rel}` : dir)
const cleanRel = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
    .replace(/^\.$/, "")

/** Mutable copy of a scenario's engine data for one page. */
function engineState(scenario) {
  const e = structuredClone(scenario.engine)
  const files = new Map()
  for (const [rel, v] of Object.entries(scenario.files ?? {})) {
    files.set(cleanRel(rel), Buffer.isBuffer(v) ? v : typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v.base64, "base64"))
  }
  const sessions = new Map(e.sessions.map((s) => [s.id, s]))
  const workspaces = [...new Set([e.home, e.directory, ...e.sessions.map((s) => s.directory), ...(e.workspaces ?? [])])]
  return {
    now: e.now ?? Date.now(),
    directory: e.directory,
    home: e.home,
    workspaces,
    sessions,
    messages: e.messages ?? {},
    status: e.status ?? {},
    answers: e.answers ?? {},
    pendingAnswers: e.pendingAnswers ?? {},
    /** Messages reads held back by a `hold` step, per session: { gate, release(), waiting }. */
    holds: new Map(),
    attempts: e.attempts ?? {},
    permissions: e.permissions ?? [],
    questions: e.questions ?? [],
    events: e.events ?? [],
    providers: e.providers ?? { providers: [], default: {} },
    keys: e.keys ?? { providers: [], default: {} },
    router: e.router ?? { at: e.now ?? Date.now(), backends: [], aliases: { auto: null, fast: null }, authFailures: [], keyCooldowns: [] },
    files,
    prompts: [],
    created: 0,
  }
}

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "no-store" } })
const notFound = (message) => json({ name: "NotFoundError", data: { message } }, 404)

/**
 * A text or reasoning part that is still streaming. OpenCode 1.18 stores it empty when it
 * starts and sends what follows only as message.part.delta events; the full text is stored
 * (and sent as message.part.updated) when the part ends.
 */
const isStreaming = (part) => (part.type === "text" || part.type === "reasoning") && !!part.time && part.time.end === undefined

/** Marks a part the kit built with `later: true`: it starts after the page opened, so no read returns it until a step emits its opening update. */
const LATER = "__harnessStartsLater"

/** A message as GET /session/:id/message returns it: streaming parts as stored, empty; parts that haven't started yet left out. */
const stored = (m) => ({ info: m.info, parts: m.parts.filter((p) => !p[LATER]).map((p) => (isStreaming(p) ? { ...p, text: "" } : p)) })

/**
 * Keeps the fake's stored state in step with an event a scenario emits, the way the engine's own
 * state changes before it publishes the event: a reload or a re-read after it sees the same thing.
 * Deltas change nothing stored (the engine writes a streaming part only when it starts and ends).
 */
function applyEvent(st, ev) {
  const p = ev.properties ?? {}
  const messagesOf = (sid) => (st.messages[sid] ??= [])
  if (ev.type === "message.part.updated" && p.part) {
    const list = messagesOf(p.part.sessionID)
    const msg = list.find((m) => m.info.id === p.part.messageID)
    if (!msg) return
    const i = msg.parts.findIndex((x) => x.id === p.part.id)
    if (i >= 0) msg.parts[i] = structuredClone(p.part)
    else msg.parts.push(structuredClone(p.part))
  } else if (ev.type === "message.updated" && p.info) {
    const list = messagesOf(p.info.sessionID)
    const msg = list.find((m) => m.info.id === p.info.id)
    if (msg) msg.info = structuredClone(p.info)
    else list.push({ info: structuredClone(p.info), parts: [] })
    // The router writes its row for a step when the request ends; a routed step that completes here gets the one the kit prepared.
    const done = p.info.time?.completed
    const pending = st.pendingAnswers[p.info.sessionID] ?? []
    const i = pending.findIndex((x) => x.messageID === p.info.id)
    if (done && i >= 0) {
      const { messageID: _id, created, ...row } = pending.splice(i, 1)[0]
      void _id
      const ts = done - 40
      ;(st.answers[p.info.sessionID] ??= []).push({ ts, ...row, latencyMs: ts - (created + 120) })
    }
  } else if (ev.type === "session.status" && p.sessionID) st.status[p.sessionID] = p.status
  else if (ev.type === "session.idle" && p.sessionID) st.status[p.sessionID] = { type: "idle" }
  else if (ev.type === "permission.asked" && !st.permissions.some((x) => x.id === p.id)) st.permissions.push(structuredClone(p))
  else if (ev.type === "permission.replied") st.permissions = st.permissions.filter((x) => x.id !== p.requestID)
  else if (ev.type === "question.asked" && !st.questions.some((x) => x.id === p.id)) st.questions.push(structuredClone(p))
  else if (ev.type === "question.replied" || ev.type === "question.rejected") st.questions = st.questions.filter((x) => x.id !== p.requestID)
}

/** Windows or POSIX path helpers, by the look of the fixture's paths. */
const pathFor = (p) => (isWin(p) ? path.win32 : path.posix)

function isDirRel(st, rel) {
  return !rel || [...st.files.keys()].some((f) => f.startsWith(`${rel}/`))
}

/** GET /file?path=… : one folder's entries, shaped like the engine's (relative path with the OS separator, a trailing one for folders). */
function listFolder(st, directory, p) {
  if (!samePath(directory, st.directory)) return []
  const relDir = cleanRel(p)
  if (!isDirRel(st, relDir)) return null
  const sep = isWin(st.directory) ? "\\" : "/"
  const out = new Map()
  for (const f of st.files.keys()) {
    if (relDir && !f.startsWith(`${relDir}/`)) continue
    const [head, ...more] = (relDir ? f.slice(relDir.length + 1) : f).split("/")
    const childRel = relDir ? `${relDir}/${head}` : head
    if (more.length) out.set(head, { name: head, rel: childRel, type: "directory" })
    else if (!out.has(head)) out.set(head, { name: head, rel: childRel, type: "file" })
  }
  return [...out.values()]
    .sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name))
    .map((x) => ({ name: x.name, path: `${x.rel.split("/").join(sep)}${x.type === "directory" ? sep : ""}`, absolute: joinAbs(st.directory, x.rel), type: x.type, ignored: false }))
}

function projects(st) {
  const dirs = [...new Set([st.directory, ...[...st.sessions.values()].map((s) => s.directory)])]
  return dirs.map((d) => {
    const mine = [...st.sessions.values()].filter((s) => samePath(s.directory, d))
    const times = mine.map((s) => s.time.updated)
    return {
      id: samePath(d, st.home) ? "global" : (mine[0]?.projectID ?? d.replace(/\W+/g, "").slice(-40)),
      worktree: d,
      vcs: "git",
      time: { created: Math.min(st.now - 30 * 86_400_000, ...times), updated: Math.max(st.now - 86_400_000, ...times) },
      sandboxes: [],
    }
  })
}

function newSession(st, directory, title) {
  st.created++
  const id = `ses_harness${String(st.created).padStart(4, "0")}${"x".repeat(13)}`
  const s = { id, slug: "harness-chat", projectID: "harness", directory, summary: { additions: 0, deletions: 0, files: 0 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, title: title ?? "New session", agent: "build", model: { id: "auto", providerID: "syrup", variant: "default" }, version: "1.18.32", time: { created: st.now, updated: st.now } }
  st.sessions.set(id, s)
  st.messages[id] = []
  return s
}

/** The engine routes the browser uses (src/lib/engine-store.tsx, workspace-fs.ts, file-actions.ts), plus the rest of the read API. */
function engineApi(st, method, p, q, body) {
  const directory = q.get("directory") ?? st.directory
  let m
  if (method === "GET" && p === "/path") return json({ home: "C:\\Users\\dev", state: "C:\\Users\\dev\\.local\\state\\opencode", config: "C:\\Users\\dev\\.config\\opencode", worktree: st.directory, directory: st.directory })
  if (method === "GET" && p === "/project") return json(projects(st))
  if (method === "GET" && p === "/project/current") return json(projects(st).find((x) => samePath(x.worktree, directory)) ?? null)
  if (method === "GET" && p === "/config/providers") return json(st.providers)
  if (method === "GET" && p === "/config") return json({ model: "syrup/auto", small_model: "syrup/fast" })
  if (method === "GET" && p === "/provider") return json({ all: st.providers.providers, default: st.providers.default, connected: st.providers.providers.map((x) => x.id) })
  if (p === "/session") {
    if (method === "GET") return json([...st.sessions.values()].filter((s) => samePath(s.directory, directory)).sort((a, b) => b.time.updated - a.time.updated))
    if (method === "POST") return json(newSession(st, directory, body?.title))
  }
  if (method === "GET" && p === "/session/status") {
    const out = {}
    for (const [id, s] of Object.entries(st.status)) if (st.sessions.get(id) && samePath(st.sessions.get(id).directory, directory) && s.type !== "idle") out[id] = s
    return json(out)
  }
  if ((m = p.match(/^\/session\/([^/]+)$/))) {
    const s = st.sessions.get(m[1])
    if (!s) return notFound(`Session not found: ${m[1]}`)
    if (method === "GET") return json(s)
    if (method === "PATCH") {
      if (typeof body?.title === "string") s.title = body.title
      return json(s)
    }
    if (method === "DELETE") {
      st.sessions.delete(m[1])
      return json(true)
    }
  }
  if ((m = p.match(/^\/session\/([^/]+)\/message$/)) && method === "GET") {
    if (!st.sessions.get(m[1])) return notFound(`Session not found: ${m[1]}`)
    return json((st.messages[m[1]] ?? []).map(stored))
  }
  if ((m = p.match(/^\/session\/([^/]+)\/message\/([^/]+)$/)) && method === "GET") {
    const msg = (st.messages[m[1]] ?? []).find((x) => x.info.id === m[2])
    return msg ? json(stored(msg)) : notFound(`Message not found: ${m[2]}`)
  }
  if ((m = p.match(/^\/session\/([^/]+)\/(prompt_async|abort|permissions\/[^/]+|todo|diff|children)$/))) {
    if (m[2] === "prompt_async" && method === "POST") {
      st.prompts.push({ sessionID: m[1], body })
      return { status: 204, body: "" }
    }
    // An answered permission is no longer pending (a reload must not bring its card back).
    if (m[2].startsWith("permissions/") && method === "POST") st.permissions = st.permissions.filter((x) => x.id !== m[2].slice("permissions/".length))
    if (method === "POST") return json(true)
    return json([])
  }
  if (method === "GET" && p === "/permission") return json(st.permissions)
  if (method === "GET" && p === "/question") return json(st.questions)
  if (method === "POST" && (m = p.match(/^\/question\/([^/]+)\/(reply|reject)$/))) {
    st.questions = st.questions.filter((x) => x.id !== m[1])
    return json(true)
  }
  if (method === "GET" && p === "/file") {
    const entries = listFolder(st, directory, q.get("path") ?? ".")
    return entries ? json(entries) : notFound(`No such directory: ${q.get("path")}`)
  }
  if (method === "GET" && p === "/file/content") {
    const buf = samePath(directory, st.directory) ? st.files.get(cleanRel(q.get("path"))) : undefined
    if (!buf) return notFound(`File not found: ${q.get("path")}`)
    const text = buf.subarray(0, 8192).includes(0) ? null : buf.toString("utf8")
    return json(text !== null ? { type: "text", content: text } : { type: "text", content: buf.toString("base64"), encoding: "base64", mimeType: "application/octet-stream" })
  }
  if (method === "GET" && p === "/file/status") return json([])
  if (method === "GET" && p === "/find/file") {
    const needle = (q.get("query") ?? "").toLowerCase()
    return json([...st.files.keys()].filter((f) => f.toLowerCase().includes(needle)).slice(0, 50))
  }
  return null
}

/** Local routes outside the engine proxy that the chat screens call. */
function appApi(st, method, p, q, body) {
  if (method === "GET" && p === "/api/workspace/home") return json({ path: st.home })
  if (method === "GET" && p === "/api/workspace") {
    // The fixture's folders and every folder above them exist; the scenario's workspaces are git repos, Home is not.
    const target = q.get("path") || st.home
    const P = pathFor(target)
    const known = new Map()
    for (const w of st.workspaces) {
      for (let d = w; ; d = P.dirname(d)) {
        if (![...known.keys()].some((k) => samePath(k, d))) known.set(d, !samePath(d, st.home) && st.workspaces.some((x) => samePath(x, d)))
        if (P.dirname(d) === d) break
      }
    }
    const exists = [...known.keys()].some((k) => samePath(k, target))
    if (q.get("probe")) return json({ path: target, exists })
    const parent = P.dirname(target) === target ? null : P.dirname(target)
    if (!exists) return json({ path: target, exists: false, dirs: [], parent })
    const dirs = [...known]
      .filter(([d]) => !samePath(d, target) && samePath(P.dirname(d), target))
      .map(([d, git]) => ({ name: P.basename(d), path: d, git }))
      .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name))
    const git = [...known].some(([d, g]) => g && samePath(d, target))
    return json({ path: target, exists: true, git, parent, dirs, home: "C:\\Users\\dev" })
  }
  // Never shows or opens anything on the machine running the harness.
  if (method === "POST" && p === "/api/workspace/reveal") return json({ ok: true, path: body?.path ?? "" })
  if (method === "POST" && p === "/api/workspace/pick") return json({ cancelled: true })
  if (p === "/api/workspace/files") {
    if (!samePath(q.get("workspace"), st.directory)) return json({ error: "not found" }, 404)
    const r = cleanRel(q.get("path"))
    const buf = st.files.get(r)
    const mtime = st.now - 5 * 60_000
    if (method === "GET" && q.get("op") === "stat") {
      if (buf) return json({ size: buf.length, type: "file", mtime })
      return isDirRel(st, r) ? json({ size: 0, type: "directory", mtime }) : json({ error: "not found" }, 404)
    }
    if (method === "GET" && q.get("op") === "raw") {
      if (!buf) return json({ error: "not found" }, 404)
      return { status: 200, body: buf, headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" } }
    }
    return null
  }
  if (method === "GET" && p === "/api/router/answers") {
    const id = q.get("session") ?? ""
    const out = { answers: st.answers[id] ?? [] }
    if (q.get("live")) out.attempts = st.attempts[id] ?? []
    return json(out)
  }
  if (method === "GET" && p === "/api/router/status") return json(st.router)
  if (method === "GET" && p === "/api/providers") return json(st.keys)
  if (p === "/api/feedback") return method === "GET" ? json({ ratings: {} }) : json({ ok: true })
  // Client logs (src/lib/clientlog.ts) stay out of the real log table.
  if (p === "/api/logs") return method === "POST" ? json({ ok: true }) : json({ rows: [] })
  if (method === "GET" && p === "/api/shares") return json({ shares: [] })
  return null
}

/**
 * What the event stream sends after server.connected: only the scenario's own `engine.events`.
 * The real engine replays nothing when a stream opens (no session.status for a busy session, no
 * pending permission or question, no text a streaming part already has), so the page asks for
 * those itself (GET /session/status, /permission, /question) and a part that is already streaming
 * is one it joined mid-stream. A scenario that wants a page watching a part from its start opens
 * the part with `later: true` and emits its opening update and deltas in steps (docs/TESTING.md).
 */
function openingEvents(st) {
  return st.events
}

/**
 * Points a browser context at the scenario's fake engine: seeds the local workspace list
 * (localStorage, as the app keeps it), freezes the clock, and answers the app's API.
 * Returns the request log and push(events) for the open event stream.
 */
export async function installFakeEngine(context, scenario, { base, events, channel }) {
  const origin = new URL(base).origin
  const st = engineState(scenario)
  const log = { unmocked: [], external: [], harness: [], blocked: [], requests: 0, lastRequestAt: Date.now() }
  for (const ev of st.events) applyEvent(st, ev)
  events.open(channel, () => openingEvents(st))

  await context.clock.setFixedTime(new Date(st.now))
  const seed = {
    workspaces: st.workspaces.filter((w) => samePath(w, st.home) || samePath(w, st.directory)).map((w, i) => ({ path: w, color: samePath(w, st.home) ? 0 : 3 + i, used: st.now - (samePath(w, st.directory) ? 0 : 86_400_000) })),
    directory: st.directory,
    model: scenario.model ?? { providerID: "syrup", modelID: "auto" },
    panel: { open: false, width: 440, showHidden: false, wrap: true, ...(scenario.panelPrefs ?? {}) },
  }
  await context.addInitScript((s) => {
    try {
      // Sandboxed preview frames have no storage; the app's own tab is seeded once, so a reload in a step keeps what the app wrote.
      if (window.top !== window || sessionStorage.getItem("ui-harness.seeded")) return
      localStorage.clear()
      localStorage.setItem("syrup.workspaces", JSON.stringify(s.workspaces))
      localStorage.setItem("syrup.directory", s.directory)
      localStorage.setItem("syrup.model", JSON.stringify(s.model))
      localStorage.setItem("syrup.panel", JSON.stringify(s.panel))
      localStorage.setItem("syrup.sidebar", "full")
      sessionStorage.setItem("ui-harness.seeded", "1")
    } catch {}
  }, seed)

  await context.route(
    (url) => url.origin === origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ingest/")),
    async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const method = req.method()
      log.requests++
      log.lastRequestAt = Date.now()
      try {
        // PostHog's first-party proxy (next.config.ts): fixtures never send analytics.
        if (url.pathname.startsWith("/ingest/")) return await route.fulfill({ status: 204, body: "" })
        if (url.pathname === "/api/oc/event") return await route.continue({ url: events.url(channel, url.search) })
        let body = null
        try {
          body = req.postDataJSON()
        } catch {}
        const res = url.pathname.startsWith("/api/oc/") ? engineApi(st, method, url.pathname.slice("/api/oc".length), url.searchParams, body) : appApi(st, method, url.pathname, url.searchParams, body)
        // A held messages read: the engine answers now (its state as of the request), the answer reaches the page on `release`.
        const held = method === "GET" && /^\/api\/oc\/session\/[^/]+\/message$/.test(url.pathname) ? st.holds.get(url.pathname.split("/")[4]) : undefined
        if (res && held) {
          held.waiting++
          await held.gate
        }
        if (res) return await route.fulfill(res)
        log.unmocked.push(`${method} ${url.pathname}${url.search}`)
        return await route.fulfill(json({ error: `ui-harness: no fixture for ${method} ${url.pathname}` }, 501))
      } catch (err) {
        // The page went away mid-request (context closed): nothing to answer.
        if (/closed|Target page|has been closed/i.test(String(err))) return
        log.harness.push(`${method} ${url.pathname}: ${err instanceof Error ? err.message : err}`)
        await route.fulfill(json({ error: "ui-harness failed" }, 500)).catch(() => {})
      }
    },
  )
  // Anything off this origin (fonts are self-hosted by next/font, so nothing should be) is blocked and listed.
  await context.route(
    (url) => /^https?:$/.test(url.protocol) && url.origin !== origin && url.origin !== events.origin,
    (route) => {
      log.external.push(`${route.request().method()} ${route.request().url()}`)
      return route.abort("blockedbyclient")
    },
  )
  // Requests a scenario blocks (`block`, globs): the network failing for them, as offline or after a deploy removed old chunks.
  for (const glob of scenario.block ?? []) {
    await context.route(glob, (route) => {
      log.blocked.push(route.request().url())
      return route.abort("blockedbyclient")
    })
  }
  const push = (evs) => {
    const list = Array.isArray(evs) ? evs : [evs]
    for (const ev of list) applyEvent(st, ev)
    return events.push(channel, list)
  }
  return {
    log,
    state: st,
    push,
    /** From now on, the session's messages reads are answered with the state as of the request, and held until `release`. */
    hold(sessionID) {
      let release
      const gate = new Promise((r) => (release = r))
      st.holds.set(sessionID, { gate, release, waiting: 0 })
    },
    /** How many of the session's reads are being held. */
    held: (sessionID) => st.holds.get(sessionID)?.waiting ?? 0,
    release(sessionID) {
      st.holds.get(sessionID)?.release()
      st.holds.delete(sessionID)
    },
    releaseAll() {
      for (const id of [...st.holds.keys()]) this.release(id)
    },
    /** Ends the page's event stream like a network drop; the page reconnects by itself (about 1.5 s later). */
    drop() {
      events.drop(channel)
      events.open(channel, () => openingEvents(st))
    },
    connected: () => events.clients(channel) > 0,
  }
}

// ---------------------------------------------------------------- waiting for a screen

const CHAT_ROUTE = /^\/s\/[^/?#]+/

/** The engine booted and the event stream is open (the sidebar's dot), then the route's own content. */
export async function waitUntilReady(page, scenario, timeout = 30_000) {
  await page.waitForSelector('span[title="Connected to engine"]', { state: "attached", timeout })
  if (CHAT_ROUTE.test(scenario.route)) {
    // Messages loaded: the chat column is there and its skeleton (rendered from the first paint) is gone.
    await page.waitForFunction(() => {
      const log = document.querySelector(".chat-log")
      return !!log && !log.querySelector("[aria-busy]")
    }, null, { timeout })
  } else if (scenario.route === "/") {
    await page.waitForFunction(() => document.body.innerText.includes("Working in"), null, { timeout })
  }
  for (const sel of [scenario.ready ?? []].flat()) await page.locator(sel).first().waitFor({ state: "visible", timeout })
  await page.evaluate(() => document.fonts.ready)
}

/** Waits until no fixture request has started for `quietMs` (polling requests aside, the page has settled). */
async function networkQuiet(handle, quietMs = 500, maxMs = 5_000) {
  const t0 = Date.now()
  while (Date.now() - handle.log.lastRequestAt < quietMs && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 100))
}

/**
 * Waits until the page's text and element count stop changing for `quietMs`: the typewriter
 * reveals text that grows while it is on screen (at most about 1.5 s behind the stream), and
 * later rounds add renderers that load on first use. False if it was still changing at `maxMs`.
 */
export async function waitForStable(page, quietMs = 600, maxMs = 12_000) {
  const t0 = Date.now()
  let last = ""
  let since = Date.now()
  while (Date.now() - t0 < maxMs) {
    const sig = await page.evaluate(() => `${document.body.textContent?.length ?? 0}:${document.body.getElementsByTagName("*").length}`)
    if (sig !== last) {
      last = sig
      since = Date.now()
    } else if (Date.now() - since >= quietMs) return true
    await page.waitForTimeout(150)
  }
  return false
}

// ---------------------------------------------------------------- panel and steps

const TAB_LABEL = { changes: "Changes", files: "Files", preview: "Preview" }

/** Opens the workspace panel like a user: the panel button, the tab, then the file in the Files tree (which shows it in Preview). */
async function openPanel(page, { tab = "files", file }) {
  const root = page.locator('[aria-label="Workspace panel"]')
  if (!(await root.count())) {
    await page.locator('button[title^="Show changes, files & preview"]').filter({ visible: true }).first().click()
    await root.first().waitFor({ state: "visible" })
  }
  const tabButton = (label) => root.locator("button").filter({ hasText: new RegExp(`^${label}`) }).first()
  if (!file) {
    await tabButton(TAB_LABEL[tab]).click()
    return
  }
  await tabButton("Files").click()
  const parts = file.split("/")
  for (let i = 1; i < parts.length; i++) {
    const folder = root.locator(`[role="treeitem"][title="${parts.slice(0, i).join("/")}"]`)
    if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click()
  }
  await root.locator(`[role="treeitem"][title="${file}"]`).click()
  if (tab !== "preview") await tabButton(TAB_LABEL[tab]).click()
  // Loaded: the file's size shows next to its path, and no loader is left in the panel.
  await page.waitForFunction(() => {
    const el = document.querySelector('[aria-label="Workspace panel"]')
    return !!el && !el.querySelector('[role="status"][aria-label]') && /\d+(\.\d+)?\s?(B|KB|MB)/.test(el.textContent ?? "")
  })
}

const STEP_KINDS = ["click", "tap", "hover", "fill", "type", "press", "waitFor", "wait", "emit", "scroll", "settle", "assert", "reload", "back", "resize", "drag", "hold", "held", "release", "dropStream", "awaitStream"]
const ASSERT_KINDS = ["visible", "hidden", "text", "count", "box", "inView"]

/** Polls `ok()` every 50 ms until it holds; throws `what` after `ms`. */
async function until(ok, what, ms = 10_000) {
  const t0 = Date.now()
  while (!(await ok())) {
    if (Date.now() - t0 > ms) throw new Error(what)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Steps (all selectors are Playwright selectors: CSS, text=…, role=…):
 *   { click: sel } · { tap: sel } · { hover: sel } · { fill: [sel, text] } · { type: [sel, text] }
 *   { press: key } or { press: [sel, key] } · { waitFor: sel } · { wait: ms }
 *   { emit: event | event[], every?: ms }   push engine events into the open stream (with `every`, one at a time,
 *                                           that many ms apart, like a model writing); the fake's stored state follows
 *   { scroll: [sel, "top" | "bottom"] }
 *   { settle: true }                        wait until the screen stops changing (typewriter, lazy renderers)
 *   { assert: assertion }                   check something now, mid-scenario (same shapes as `assert`, `gap` too)
 *   { reload: true }                        reload the page and wait for it like the first load (the stream
 *                                           replays nothing, so the page must restore what it shows)
 *   { back: true }                          the browser's back button
 *   { resize: [width, height] }             resize the window (the run's checks still measure at its own width)
 *   { drag: [sel, dx] }                     press on the element, move dx pixels sideways (negative: left), let go
 *   { hold: sessionID }                     from now on, that chat's messages reads are answered with the engine's state
 *                                           as of the request but reach the page only on { release: sessionID }
 *   { held: sessionID }                     wait until such a read is being held (up to 10 s)
 *   { release: sessionID }                  let the held reads through (a read the engine answered before what
 *                                           happened since: it must not undo what the stream already showed)
 *   { dropStream: true }                    end the page's event stream like a network drop (the page reconnects itself)
 *   { awaitStream: true }                   wait until the page has its event stream open again (up to 10 s)
 * Any step may carry `widths: [390]` to run at some widths only. Every step but `assert` waits 120 ms after itself.
 */
async function runStep(page, step, ctx) {
  const { handle, scenario, result, index } = ctx
  if ("click" in step) await page.locator(step.click).first().click()
  else if ("tap" in step) await page.locator(step.tap).first().tap()
  else if ("hover" in step) await page.locator(step.hover).first().hover()
  else if ("fill" in step) await page.locator(step.fill[0]).first().fill(step.fill[1])
  else if ("type" in step) await page.locator(step.type[0]).first().pressSequentially(step.type[1], { delay: 15 })
  else if ("press" in step) {
    if (Array.isArray(step.press)) await page.locator(step.press[0]).first().press(step.press[1])
    else await page.keyboard.press(step.press)
  } else if ("waitFor" in step) await page.locator(step.waitFor).first().waitFor({ state: "visible" })
  else if ("wait" in step) await page.waitForTimeout(step.wait)
  else if ("emit" in step) {
    const list = [step.emit].flat()
    if (!step.every) {
      if (!handle.push(list)) throw new Error("emit: the event stream is not connected")
    } else {
      for (const ev of list) {
        if (!handle.push(ev)) throw new Error("emit: the event stream is not connected")
        await new Promise((r) => setTimeout(r, step.every))
      }
    }
  } else if ("scroll" in step) await page.locator(step.scroll[0]).first().evaluate((el, to) => (el.scrollTop = to === "top" ? 0 : el.scrollHeight), step.scroll[1])
  else if ("settle" in step) {
    if (!(await waitForStable(page))) result.notes.push(`step ${index + 1}: the screen was still changing; checked anyway`)
  } else if ("assert" in step) {
    recordAssertion(result, scenario, await checkAssertion(page, step.assert), step.assert, `step ${index + 1}: `)
    return
  } else if ("reload" in step) {
    await page.reload({ waitUntil: "load", timeout: 90_000 })
    await waitUntilReady(page, scenario)
  } else if ("back" in step) {
    await page.goBack({ waitUntil: "commit" })
  } else if ("resize" in step) await page.setViewportSize({ width: step.resize[0], height: step.resize[1] })
  else if ("drag" in step) {
    // Press in the middle of the element, move sideways in small steps (each one a pointermove), let go.
    const box = await page.locator(step.drag[0]).first().boundingBox()
    if (!box) throw new Error(`drag: ${step.drag[0]} is not on screen`)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + step.drag[1], y, { steps: 12 })
    await page.mouse.up()
  } else if ("hold" in step) handle.hold(step.hold)
  else if ("held" in step) await until(() => handle.held(step.held) > 0, `held: no messages read of ${step.held} arrived`)
  else if ("release" in step) handle.release(step.release)
  else if ("dropStream" in step) handle.drop()
  else if ("awaitStream" in step) await until(() => handle.connected(), "awaitStream: the page did not reconnect its event stream")
  await page.waitForTimeout(120)
}

/** Adds one assertion's outcome. A known gap (`gap`) must fail, and fails the run once it passes. */
function recordAssertion(result, scenario, r, a, prefix = "") {
  const labelled = { ...r, label: `${prefix}${r.label}` }
  if (!a.gap) result.assertions.push(labelled)
  // A known gap must fail until the app is fixed; once it passes, its note has to go, or the gap would hide a regression later.
  else if (r.ok) result.assertions.push({ ...labelled, ok: false, detail: `passes now, so this gap is closed: delete its gap note in ${scenario.file}` })
  else result.assertions.push({ ...labelled, ok: true, gap: a.gap })
}

// ---------------------------------------------------------------- checks

/**
 * Sideways overflow, measured against the device width (mobile Chrome widens its layout viewport to fit a too-wide page),
 * plus a chat column squeezed too narrow to read.
 */
export async function measureOverflow(page, deviceWidth) {
  return page.evaluate((device) => {
    const describe = (el) => {
      const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""
      const txt = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)
      return `${el.tagName.toLowerCase()}${cls}${txt ? ` "${txt}"` : ""}`
    }
    /**
     * What pokes out past `box`'s right edge, not inside a scroller or clipper of its own: an element whose box sticks
     * out, or one whose own content does (a line that can't wrap runs past a box that fits). Innermost culprit first.
     */
    const offenders = (box) => {
      const right = box.getBoundingClientRect().right
      const found = []
      for (const el of box.querySelectorAll("*")) {
        const r = el.getBoundingClientRect()
        if (!r.width) continue
        const content = getComputedStyle(el).overflowX === "visible" && el.clientWidth ? r.left + el.scrollWidth : r.right
        const px = Math.round(Math.max(r.right, content) - right)
        if (px <= 1) continue
        let p = el.parentElement
        let clipped = false
        while (p && p !== box) {
          if (getComputedStyle(p).overflowX !== "visible") {
            clipped = true
            break
          }
          p = p.parentElement
        }
        if (!clipped) found.push({ node: el, px })
      }
      // A wrapper that sticks out only because of something inside it says less than that thing: name the inner one.
      const inner = found.filter((f) => !found.some((g) => g !== f && f.node.contains(g.node) && g.px >= f.px - 1))
      return inner
        .sort((a, b) => b.px - a.px)
        .slice(0, 3)
        .map((f) => ({ el: describe(f.node), px: f.px }))
    }
    const de = document.documentElement
    const main = document.querySelector("main")
    const page = { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth, mainRight: main ? Math.round(main.getBoundingClientRect().right) : 0 }
    const pageOver = Math.max(page.scrollWidth, page.innerWidth, page.mainRight) - device
    const problems = []
    if (pageOver > 1 || page.scrollWidth > page.clientWidth + 1) problems.push(`page is ${Math.max(pageOver, page.scrollWidth - page.clientWidth)}px wider than the screen${main ? ` (${offenders(document.body).map((o) => `${o.el} +${o.px}px`).join(", ")})` : ""}`)
    const log = document.querySelector(".chat-log")
    if (log && log.getClientRects().length && log.scrollWidth > log.clientWidth + 1) problems.push(`chat column overflows by ${log.scrollWidth - log.clientWidth}px: ${offenders(log).map((o) => `${o.el} +${o.px}px`).join(", ")}`)
    // Squeezed is broken too, even with nothing poking out: words wrap letter by letter and the composer's buttons overlap.
    const minChat = Math.min(280, device)
    const chatWidth = log && log.getClientRects().length ? Math.round(log.getBoundingClientRect().width) : null
    if (chatWidth !== null && chatWidth < minChat - 1) problems.push(`chat column squeezed to ${chatWidth}px (under ${minChat}px): something beside it takes the room`)
    const panel = document.querySelector('[aria-label="Workspace panel"]')
    if (panel && panel.getClientRects().length) {
      const r = panel.getBoundingClientRect()
      if (r.right > device + 1) problems.push(`panel ends ${Math.round(r.right - device)}px past the screen`)
      if (panel.scrollWidth > panel.clientWidth + 1) problems.push(`panel overflows by ${panel.scrollWidth - panel.clientWidth}px: ${offenders(panel).map((o) => `${o.el} +${o.px}px`).join(", ")}`)
    }
    // Controls that must stay reachable (docs/RESPONSIVE.md): checked only when on screen.
    for (const sel of ['button[aria-label="Send"]', 'button[aria-label="Chat options"]', 'button[aria-label="Open menu"]', 'button[aria-label="Close panel"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect()
        if (!r.width || getComputedStyle(el).visibility === "hidden") continue
        if (r.right > device + 1 || r.left < -1) problems.push(`${sel} is off screen (${Math.round(r.left)}–${Math.round(r.right)}px)`)
      }
    }
    return { page, problems }
  }, deviceWidth)
}

async function checkAssertion(page, a) {
  try {
    if ("visible" in a) {
      const n = await page.locator(a.visible).filter({ visible: true }).count()
      return { ok: n > 0, label: `visible ${a.visible}`, detail: n ? "" : "nothing visible matches" }
    }
    if ("hidden" in a) {
      const n = await page.locator(a.hidden).filter({ visible: true }).count()
      return { ok: n === 0, label: `hidden ${a.hidden}`, detail: n ? `${n} visible` : "" }
    }
    if ("text" in a) {
      const has = await page.evaluate((t) => document.body.innerText.includes(t), a.text)
      return { ok: has, label: `text "${a.text.length > 50 ? `${a.text.slice(0, 47)}…` : a.text}"`, detail: has ? "" : "not on the page" }
    }
    if ("count" in a) {
      const n = await page.locator(a.count).count()
      const ok = (a.equals === undefined || n === a.equals) && (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max)
      const want = a.equals !== undefined ? `= ${a.equals}` : [a.min !== undefined ? `≥ ${a.min}` : "", a.max !== undefined ? `≤ ${a.max}` : ""].filter(Boolean).join(" ")
      return { ok, label: `count ${a.count} ${want}`, detail: ok ? "" : `found ${n}` }
    }
    if ("box" in a) {
      // The first visible match's rendered width, in CSS pixels.
      const el = page.locator(a.box).filter({ visible: true }).first()
      const want = [a.minWidth !== undefined ? `width ≥ ${a.minWidth}` : "", a.maxWidth !== undefined ? `width ≤ ${a.maxWidth}` : ""].filter(Boolean).join(", ")
      if (!(await el.count())) return { ok: false, label: `box ${a.box} ${want}`, detail: "nothing visible matches" }
      const w = Math.round((await el.boundingBox())?.width ?? 0)
      const ok = (a.minWidth === undefined || w >= a.minWidth) && (a.maxWidth === undefined || w <= a.maxWidth)
      return { ok, label: `box ${a.box} ${want}`, detail: ok ? "" : `${w}px wide` }
    }
    if ("inView" in a) {
      // The last visible match lies inside the window, and with `above`, wholly above that element's top (the composer
      // floats over the end of the chat, so text under it can't be read).
      const label = `in view ${a.inView}${a.above ? ` above ${a.above}` : ""}`
      const el = page.locator(a.inView).filter({ visible: true }).last()
      if (!(await el.count())) return { ok: false, label, detail: "nothing visible matches" }
      const box = await el.boundingBox()
      let limit = page.viewportSize()?.height ?? 0
      if (a.above) {
        const over = await page.locator(a.above).filter({ visible: true }).first().boundingBox()
        if (!over) return { ok: false, label, detail: `${a.above}: nothing visible matches` }
        limit = Math.min(limit, over.y)
      }
      const top = Math.round(box?.y ?? -1)
      const bottom = Math.round((box?.y ?? 0) + (box?.height ?? 0))
      const ok = !!box && top >= 0 && bottom <= limit + 1
      return { ok, label, detail: ok ? "" : `spans ${top}–${bottom}px; the visible area ends at ${Math.round(limit)}px` }
    }
  } catch (err) {
    return { ok: false, label: JSON.stringify(a), detail: err instanceof Error ? err.message.split("\n")[0] : String(err) }
  }
  return { ok: false, label: JSON.stringify(a), detail: "unknown assertion" }
}

/** How much taller the viewport must be for the tallest visible scroller (chat, preview) to show everything. */
async function hiddenHeight(page) {
  return page.evaluate(() => {
    let extra = 0
    for (const el of document.querySelectorAll("main *, [aria-label='Workspace panel'] *")) {
      if (el.clientWidth < 240 || el.scrollHeight - el.clientHeight < 8) continue
      const oy = getComputedStyle(el).overflowY
      if ((oy === "auto" || oy === "scroll") && el.getClientRects().length) extra = Math.max(extra, el.scrollHeight - el.clientHeight)
    }
    return extra
  })
}

// ---------------------------------------------------------------- one run

const forWidth = (item, width) => !item.widths || item.widths.includes(width)

/**
 * Dev-server messages that change the page under test: someone saved a file in the app (other
 * agents share this dev server), so the page got a server refresh, a hot update or a reload.
 * "serverComponentChanges" arriving before hydration makes Next.js throw "Router action
 * dispatched before initialization", a page error that says nothing about the screen.
 */
const DEV_UPDATES = new Set(["serverComponentChanges", "turbopack-message", "reloadPage", "addedPage", "removedPage", "staticParamsChanged"])

/** Records the update messages the dev server sends this page over Next's HMR socket. */
function watchDevServer(page) {
  const seen = []
  page.on("websocket", (ws) => {
    if (!/\/_next\/(webpack-)?hmr\b/.test(ws.url())) return
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string" || !payload.startsWith("{")) return
      try {
        const m = JSON.parse(payload)
        if (DEV_UPDATES.has(m.type ?? m.action)) seen.push(m.type ?? m.action)
      } catch {}
    })
  })
  return seen
}

export async function runScenario(browser, scenario, width, { base, events, outDir, scale = 1, full = true, cloudFrame = false }) {
  const t0 = Date.now()
  const device = deviceFor(width, scale)
  const channel = `${scenario.name}-${width}-${Math.random().toString(36).slice(2, 8)}`
  const context = await browser.newContext({ ...device, locale: "en-US", timezoneId: "UTC", colorScheme: scenario.colorScheme ?? "light", reducedMotion: scenario.reducedMotion ?? "no-preference", serviceWorkers: "block" })
  const result = { scenario: scenario.name, width, ok: false, consoleErrors: [], pageErrors: [], warnings: [], unmocked: [], external: [], overflow: [], assertions: [], harness: [], notes: [], devUpdates: [], attempts: 1, screenshot: null, full: null, ms: 0 }
  let devUpdates = []
  try {
    const handle = await installFakeEngine(context, scenario, { base, events, channel })
    const page = await context.newPage()
    devUpdates = watchDevServer(page)
    const ignored = new Map()
    page.on("console", (msg) => {
      const where = msg.location()?.url ? ` (${msg.location().url.replace(base, "")}:${msg.location().lineNumber})` : ""
      // A request the scenario blocks on purpose (`block`) fails, and the browser says so.
      const blockedHere = scenario.block?.length && msg.type() === "error" && /net::ERR_BLOCKED_BY_CLIENT/.test(msg.text()) && handle.log.blocked.some((u) => (msg.location()?.url ?? "") === u)
      if (blockedHere) return void ignored.set("a request the scenario blocks on purpose failed (block)", (ignored.get("a request the scenario blocks on purpose failed (block)") ?? 0) + 1)
      const known = msg.type() === "error" && KNOWN_CONSOLE.find((k) => k.match.test(msg.text()))
      if (known) ignored.set(known.why, (ignored.get(known.why) ?? 0) + 1)
      else if (msg.type() === "error") result.consoleErrors.push(`${msg.text().slice(0, 400)}${where}`)
      else if (msg.type() === "warning") result.warnings.push(msg.text().slice(0, 300))
    })
    page.on("pageerror", (err) => result.pageErrors.push(`${err.name}: ${err.message}`.slice(0, 400)))
    const settle = async (when) => {
      if (!(await waitForStable(page))) result.notes.push(`the screen was still changing ${when}; captured anyway`)
    }

    await page.goto(base + scenario.route, { waitUntil: "load", timeout: 90_000 })
    await waitUntilReady(page, scenario)
    if (cloudFrame) await page.addStyleTag({ content: CLOUD_FRAME_CSS })
    await settle("after loading")
    if (scenario.panel) {
      await openPanel(page, scenario.panel)
      await settle("after opening the panel")
    }
    const steps = scenario.steps ?? []
    for (let index = 0; index < steps.length; index++) {
      if (!forWidth(steps[index], width)) continue
      const t = Date.now()
      await runStep(page, steps[index], { handle, scenario, result, index })
      // UI_HARNESS_TRACE=1: how long each step took, to find what makes a scenario slow.
      if (process.env.UI_HARNESS_TRACE) console.log(`\n  [trace] ${scenario.name} @ ${width} step ${index + 1} ${STEP_KINDS.find((k) => k in steps[index])}: ${Date.now() - t} ms`)
    }
    // Reads a scenario held and never released reach the page now, before the final checks.
    handle.releaseAll()
    // A block that matched nothing tests nothing (a renamed chunk, say).
    for (const glob of scenario.block ?? []) if (!handle.log.blocked.length) result.harness.push(`block: no request matched ${glob}, so the scenario tested nothing`)
    await networkQuiet(handle)
    await settle("before the screenshot")
    await page.waitForTimeout(scenario.settleMs ?? 200)

    result.overflow = (await measureOverflow(page, width)).problems
    for (const a of scenario.assert ?? []) {
      if (!forWidth(a, width)) continue
      recordAssertion(result, scenario, await checkAssertion(page, a), a)
    }

    const shot = path.join(outDir, `${scenario.name}-${width}.png`)
    await page.screenshot({ path: shot, animations: "disabled", caret: "hide", style: SCREENSHOT_CSS })
    result.screenshot = path.relative(ROOT, shot)
    const extra = full ? await hiddenHeight(page) : 0
    if (extra > 0) {
      await page.setViewportSize({ width, height: Math.min(device.viewport.height + extra, 12_000) })
      // A taller window fires no scroll event, so a "jump to the latest message" arrow from the short one would stay: let scrollers re-measure.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("main *, [aria-label='Workspace panel'] *")) if (/auto|scroll/.test(getComputedStyle(el).overflowY)) el.dispatchEvent(new Event("scroll"))
      })
      await page.waitForTimeout(300)
      const tall = path.join(outDir, `${scenario.name}-${width}-full.png`)
      await page.screenshot({ path: tall, animations: "disabled", caret: "hide", style: SCREENSHOT_CSS })
      result.full = path.relative(ROOT, tall)
      await page.setViewportSize(device.viewport)
    }
    // Local and cloud must render the same (docs/ROADMAP.md §2): measure again in the hosted layout chain.
    if (!cloudFrame) {
      await page.addStyleTag({ content: CLOUD_FRAME_CSS })
      await page.waitForTimeout(150)
      for (const p of (await measureOverflow(page, width)).problems) result.overflow.push(`in the cloud layout: ${p}`)
    }
    result.unmocked = handle.log.unmocked
    result.external = handle.log.external
    result.harness = handle.log.harness
    for (const [why, n] of ignored) result.notes.push(`known console error ×${n} not counted: ${why}`)
  } catch (err) {
    result.harness.push(err instanceof Error ? err.message.split("\n").slice(0, 3).join(" ") : String(err))
  } finally {
    await context.close().catch(() => {})
    events.drop(channel)
  }
  result.devUpdates = [...new Set(devUpdates)]
  result.ok = !result.consoleErrors.length && !result.pageErrors.length && !result.unmocked.length && !result.overflow.length && !result.harness.length && result.assertions.every((a) => a.ok)
  result.ms = Date.now() - t0
  return result
}

/** The first thing that made a run fail, for one line of output. */
function firstProblem(r) {
  const a = r.assertions.find((x) => !x.ok)
  return r.harness[0] ?? r.pageErrors[0] ?? r.consoleErrors[0] ?? r.overflow[0] ?? (r.unmocked[0] && `unmocked ${r.unmocked[0]}`) ?? (a ? `assert ${a.label}: ${a.detail}` : "unknown")
}

/** Runs one scenario at one width; a failed run the dev server disturbed (a file was saved mid-run) is run again, up to `reruns` times. */
export async function runScenarioSettled(browser, scenario, width, options, reruns = 2) {
  const t0 = Date.now()
  const discarded = []
  let r = await runScenario(browser, scenario, width, options)
  while (!r.ok && r.devUpdates.length && discarded.length < reruns) {
    discarded.push(`attempt ${discarded.length + 1} discarded: the dev server pushed ${r.devUpdates.join(", ")} while it ran (a file in the app was saved), and it failed with: ${firstProblem(r).slice(0, 200)}`)
    r = await runScenario(browser, scenario, width, options)
  }
  r.attempts = discarded.length + 1
  r.ms = Date.now() - t0
  r.notes.unshift(...discarded)
  if (r.ok && r.devUpdates.length) r.notes.push(`the dev server pushed ${r.devUpdates.join(", ")} during this run (a file in the app was saved); it passed anyway`)
  return r
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = argv.filter((a) => a !== "--")
  const o = { label: "latest", only: [], widths: [390, 1440], base: process.env.UI_HARNESS_BASE ?? DEFAULT_BASE, scale: 1, full: true, headed: false, list: false, cloudFrame: false, browser: "chromium", dir: SCENARIO_DIR }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = () => {
      const v = args[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === "--label") o.label = next()
    else if (a === "--only") o.only = next().split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--widths") o.widths = next().split(",").map((s) => Number(s.trim()))
    else if (a === "--base") o.base = next()
    else if (a === "--scale") o.scale = Number(next())
    else if (a === "--no-full") o.full = false
    else if (a === "--cloud-frame") o.cloudFrame = true
    else if (a === "--browser") o.browser = next()
    else if (a === "--headed") o.headed = true
    else if (a === "--list") o.list = true
    else if (a === "--dir") o.dir = path.resolve(next())
    else throw new Error(`Unknown argument ${a}. See the comment at the top of scripts/ui-harness.mjs.`)
  }
  if (!/^[\w.-]+$/.test(o.label)) throw new Error(`--label must be a plain folder name, got ${o.label}`)
  if (o.widths.some((w) => !Number.isInteger(w) || w < 280 || w > 3840)) throw new Error(`--widths must be pixel widths like 390,1440`)
  if (!["chromium", "webkit"].includes(o.browser)) throw new Error(`--browser must be chromium or webkit, got ${o.browser}`)
  o.base = o.base.replace(/\/$/, "")
  return o
}

const pad = (s, n) => String(s).padEnd(n)

function printSummary(results, outDir) {
  const rows = results.map((r) => {
    const checked = r.assertions.filter((a) => !a.gap)
    const asserts = checked.length ? `${checked.filter((a) => a.ok).length}/${checked.length}` : "-"
    const gaps = r.assertions.filter((a) => a.gap).length || "-"
    return [r.scenario, r.width, r.ok ? "ok" : "FAIL", r.consoleErrors.length, r.pageErrors.length, r.overflow.length ? "yes" : "-", asserts, gaps, r.unmocked.length || "-", `${(r.ms / 1000).toFixed(1)}s`]
  })
  const head = ["scenario", "width", "result", "console", "page", "overflow", "asserts", "gaps", "unmocked", "time"]
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)) + 2)
  console.log(`\n${head.map((h, i) => pad(h, w[i])).join("")}`)
  for (const r of rows) console.log(r.map((c, i) => pad(c, w[i])).join(""))
  const failed = results.filter((r) => !r.ok)
  for (const r of failed) {
    console.log(`\n✗ ${r.scenario} @ ${r.width}`)
    for (const e of r.harness) console.log(`  harness: ${e}`)
    for (const e of r.consoleErrors) console.log(`  console: ${e}`)
    for (const e of r.pageErrors) console.log(`  page error: ${e}`)
    for (const e of r.overflow) console.log(`  overflow: ${e}`)
    for (const e of r.unmocked) console.log(`  unmocked: ${e} (add it to the fake engine in scripts/ui-harness.mjs)`)
    for (const a of r.assertions.filter((x) => !x.ok)) console.log(`  assert: ${a.label}: ${a.detail}`)
    if (r.devUpdates.length) console.log(`  dev server: pushed ${r.devUpdates.join(", ")} during this run as well (a file in the app was saved); run again once the edits stop`)
  }
  // Known gaps: assertions that fail today on purpose. Listed every run so they stay visible.
  const gaps = new Map()
  for (const r of results) {
    for (const a of r.assertions.filter((x) => x.gap)) {
      const key = `${r.scenario}: ${a.gap}`
      const g = gaps.get(key) ?? { labels: new Set(), widths: new Set() }
      g.labels.add(a.label)
      g.widths.add(r.width)
      gaps.set(key, g)
    }
  }
  if (gaps.size) {
    console.log("\nKnown gaps (failing on purpose until the app is fixed; they don't fail the run, but one that starts passing does):")
    for (const [key, g] of gaps) console.log(`  ${key}\n    ${[...g.labels].join("\n    ")}\n    (at ${[...g.widths].join(" and ")} px)`)
  }
  // Grouped, so a note every run shares prints once with its count.
  const notes = new Map()
  for (const r of results) for (const n of r.notes) notes.set(n.replace(/×\d+ /, ""), [...(notes.get(n.replace(/×\d+ /, "")) ?? []), `${r.scenario} @ ${r.width}`])
  if (notes.size) console.log(`\nNotes:\n  ${[...notes].map(([n, where]) => `${n} (${where.length === results.length && results.length > 1 ? "every run" : where.join(", ")})`).join("\n  ")}`)
  const external = [...new Set(results.flatMap((r) => r.external))]
  if (external.length) console.log(`\nBlocked requests to other origins:\n  ${external.join("\n  ")}`)
  const shots = results.filter((r) => r.screenshot).length + results.filter((r) => r.full).length
  console.log(`\n${results.length - failed.length}/${results.length} passed · ${shots} screenshots → ${path.relative(ROOT, outDir)}`)
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const scenarios = await loadScenarios(o.only, o.dir)
  if (o.list) {
    for (const s of scenarios) console.log(`${pad(s.name, 22)} ${s.route.length > 40 ? `${s.route.slice(0, 37)}…` : s.route}\n${" ".repeat(23)}${s.description ?? ""}`)
    return 0
  }
  try {
    const r = await fetch(o.base, { redirect: "manual" })
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.error(`Can't reach ${o.base} (${e.message}). Start the app first: pnpm dev`)
    return 2
  }
  const outDir = path.join(ROOT, "screenshots", "harness", o.label)
  // A clean folder per label, so a screenshot never survives from an earlier run.
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const events = await startEventServer()
  const browser = await { chromium, webkit }[o.browser].launch({ headless: !o.headed })
  const results = []
  try {
    for (const s of scenarios) {
      for (const width of o.widths) {
        if (s.widths && !s.widths.includes(width)) continue
        process.stdout.write(`${pad(s.name, 24)} ${pad(width, 6)}`)
        const r = await runScenarioSettled(browser, s, width, { base: o.base, events, outDir, scale: o.scale, full: o.full, cloudFrame: o.cloudFrame })
        results.push(r)
        console.log(`${r.ok ? "ok  " : "FAIL"} ${(r.ms / 1000).toFixed(1)}s${r.attempts > 1 ? ` (attempt ${r.attempts}: the dev server updated the page mid-run before)` : ""}`)
      }
    }
  } finally {
    await browser.close()
    events.close()
  }
  writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify({ base: o.base, label: o.label, browser: o.browser, frame: o.cloudFrame ? "cloud" : "local", at: new Date().toISOString(), results }, null, 2)}\n`)
  printSummary(results, outDir)
  return results.every((r) => r.ok) ? 0 : 1
}

const invoked = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invoked) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    },
  )
}
