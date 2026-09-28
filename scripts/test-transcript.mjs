#!/usr/bin/env node
/**
 * Unit tests for the transcript serializers and secret redaction
 * (src/lib/transcript.ts, src/lib/redact.ts). Bundles them with esbuild, feeds
 * synthetic OpenCode messages through buildTranscript and checks what comes
 * out: secrets redacted, paths workspace-relative, engine internals dropped,
 * size caps enforced, Markdown and JSON well formed.
 *
 *   node scripts/test-transcript.mjs
 *
 * Exits non-zero when any check fails.
 */
import { build } from "esbuild"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "node_modules", ".cache", "syrup-transcript-test")
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, "transcript.mjs")
await build({
  stdin: {
    contents: ['export * from "./src/lib/transcript"', 'export * from "./src/lib/redact"'].join("\n"),
    resolveDir: root,
    loader: "ts",
    sourcefile: "transcript-test-entry.ts",
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
})
const T = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)

let failed = 0
let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// Fake secrets, built at runtime so this file never contains a literal that looks like one.
const FAKE = {
  openai: "sk-" + "proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
  anthropic: "sk-ant-" + "api03-" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0",
  openrouter: "sk-or-v1-" + "0123456789abcdef0123456789abcdef",
  google: "AIza" + "SyD-1234567890abcdefghijklmnopqrstu",
  groq: "gsk_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  nvidia: "nvapi-" + "abcdefghijklmnopqrstuvwxyz0123456789",
  github: "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  githubPat: "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
  slack: "xoxb-" + "1234567890-abcdefghijk",
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9.eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  known: "zq-unusual-format-9f8e7d6c5b4a",
}

console.log("redaction")

for (const [name, secret] of Object.entries(FAKE)) {
  if (name === "known") continue
  check(`redacts ${name}`, () => {
    const r = T.redactText(`value: ${secret} end`)
    assert(!r.text.includes(secret), `still contains the secret: ${r.text}`)
    assert(r.count >= 1, "count not incremented")
  })
}

check("redacts a PEM private key, including a truncated one", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----"
  const r = T.redactText(`key:\n${pem}\nafter`)
  assert(!r.text.includes("MIIEowIBAAKCAQEA1234"), "body kept")
  assert(r.text.includes("after"), "text after the key lost")
  const cut = T.redactText("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA")
  assert(!cut.text.includes("b3BlbnNzaC1rZXktdjEAAAAA"), "truncated body kept")
})

check("redacts connection-string passwords but keeps placeholders", () => {
  const r = T.redactText("DATABASE postgresql://app:s3cr3tP4ss@db.example.com:5432/app and mysql://root:password@localhost")
  assert(!r.text.includes("s3cr3tP4ss"), "password kept")
  assert(r.text.includes("postgresql://app:[redacted]@db.example.com"), `unexpected form: ${r.text}`)
  assert(r.text.includes("mysql://root:password@localhost"), "placeholder password was redacted")
})

check("redacts Bearer tokens and env-style assignments", () => {
  const r = T.redactText('Authorization: Bearer abc123def456ghi789jkl012mno\nexport OPENAI_API_KEY="hunter2hunter2"\nSYRUP_MASTER_KEY=bWFzdGVya2V5MTIzNDU2Nzg5MA==')
  assert(!r.text.includes("abc123def456ghi789jkl012mno"), "bearer kept")
  assert(!r.text.includes("hunter2hunter2"), "env value kept")
  assert(!r.text.includes("bWFzdGVya2V5MTIzNDU2Nzg5MA"), "master key kept")
})

check("redacts quoted values under secret keys", () => {
  const r = T.redactText('{"apiKey": "live_1234567890abcdef", "clientSecret": "abcdefgh12345678"}')
  assert(!r.text.includes("live_1234567890abcdef") && !r.text.includes("abcdefgh12345678"), r.text)
})

check("leaves ordinary text and code alone", () => {
  const text = 'Basic authentication is fine. "max_tokens": "100000", "tokenizer": "cl100k_base", const token = getToken(); task-runner sk-8'
  const r = T.redactText(text)
  eq(r.text, text, "changed")
  eq(r.count, 0, "count")
})

check("redacts exact known secrets and hides the owner email", () => {
  const r = T.redactText(`key ${FAKE.known} from sarib.owner@example.com`, { secrets: [FAKE.known], hide: [{ value: "sarib.owner@example.com", as: "[email]" }] })
  assert(!r.text.includes(FAKE.known), "known secret kept")
  assert(!r.text.includes("sarib.owner@example.com") && r.text.includes("[email]"), r.text)
})

console.log("paths")

check("Windows workspace paths become workspace-relative (all spellings)", () => {
  const roots = ["C:\\Users\\x\\syrup"]
  eq(T.normalizePaths("open C:\\Users\\x\\syrup\\src\\a.ts now", { roots }), "open src\\a.ts now", "backslash")
  eq(T.normalizePaths("c:/users/x/syrup/src/a.ts", { roots }), "src/a.ts", "forward slash, other case")
  eq(T.normalizePaths('{"filePath":"C:\\\\Users\\\\x\\\\syrup\\\\src\\\\a.ts"}', { roots }), '{"filePath":"src\\\\a.ts"}', "JSON-escaped")
  eq(T.normalizePaths("file:///C:/Users/x/syrup/README.md", { roots }), "README.md", "file URL")
  eq(T.normalizePaths('cwd: "C:\\Users\\x\\syrup"', { roots }), 'cwd: "."', "root itself")
})

check("POSIX workspace paths and home folders", () => {
  eq(T.normalizePaths("/vercel/workspace/x/y.ts", { roots: ["/vercel/workspace"] }), "x/y.ts", "sandbox root")
  eq(T.normalizePaths("/vercel/workspace2/x", { roots: ["/vercel/workspace"] }), "/vercel/workspace2/x", "prefix of another folder")
  eq(T.normalizePaths("see /vercel/.syrup/MEMORY.md", { homes: ["/vercel"] }), "see ~/.syrup/MEMORY.md", "sandbox home")
  eq(T.normalizePaths("at /home/bob/proj and /Users/alice/x"), "at ~/proj and ~/x", "linux and mac homes")
  eq(T.normalizePaths("C:\\Users\\bob\\AppData\\Roaming\\syrup"), "~\\AppData\\Roaming\\syrup", "other Windows profile")
  eq(T.normalizePaths("https://example.com/Users/list?home=/x"), "https://example.com/Users/list?home=/x", "URLs untouched")
})

console.log("transcript")

const t0 = 1_790_000_000_000
const ROOT = "C:\\Users\\x\\syrup"
const smallPng = "data:image/png;base64," + "A".repeat(200)
const bigPng = "data:image/png;base64," + "B".repeat(1_200_000)
const answers = [
  { ts: t0 + 9_000, alias: "auto", providerId: "groq", modelId: "moonshotai/kimi-k2-instruct", ttftMs: 800, latencyMs: 5_000, attempts: 1, reason: "best", inputTokens: 25_000 },
]
const messages = [
  {
    info: { id: "msg_001", sessionID: "ses_1", role: "user", time: { created: t0 }, agent: "build", model: { providerID: "syrup", modelID: "auto" }, system: "SYSTEM PROMPT OVERRIDE SHOULD NOT LEAK" },
    parts: [
      { id: "prt_003", type: "file", mime: "image/png", filename: "big.png", url: bigPng, sessionID: "ses_1", messageID: "msg_001" },
      { id: "prt_001", type: "text", text: `Fix the bug in ${ROOT}\\src\\app.ts, my key is ${FAKE.openai}`, sessionID: "ses_1", messageID: "msg_001" },
      { id: "prt_002", type: "file", mime: "image/png", filename: "shot.png", url: smallPng, sessionID: "ses_1", messageID: "msg_001" },
      { id: "prt_004", type: "text", synthetic: true, text: "Called the Read tool with the following input: {}", sessionID: "ses_1", messageID: "msg_001" },
      { id: "prt_005", type: "file", mime: "text/plain", filename: "notes.md", url: "file:///C:/Users/x/syrup/notes.md", source: { type: "file", path: `${ROOT}\\notes.md`, text: { value: "@notes.md", start: 0, end: 9 } }, sessionID: "ses_1", messageID: "msg_001" },
    ],
  },
  {
    info: {
      id: "msg_002",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: t0 + 1_000, completed: t0 + 20_000 },
      providerID: "syrup",
      modelID: "auto",
      mode: "build",
      path: { cwd: ROOT, root: ROOT },
      cost: 0,
      tokens: { input: 25_000, output: 1_200, reasoning: 300, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [
      { id: "prt_010", type: "step-start", snapshot: "abc123", sessionID: "ses_1", messageID: "msg_002" },
      { id: "prt_011", type: "reasoning", text: "Look at app.ts first.", time: { start: t0 + 1_100, end: t0 + 3_300 }, sessionID: "ses_1", messageID: "msg_002" },
      {
        id: "prt_012",
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "completed", input: { command: `cat ${ROOT}\\.env` }, output: `GROQ_API_KEY=${FAKE.groq}\nPATH=C:\\Users\\x\\bin`, title: "Read env", metadata: { secretish: "x" }, time: { start: t0 + 4_000, end: t0 + 4_500 } },
        sessionID: "ses_1",
        messageID: "msg_002",
      },
      {
        id: "prt_013",
        type: "tool",
        callID: "call_2",
        tool: "edit",
        state: { status: "error", input: { filePath: `${ROOT}\\src\\app.ts`, oldString: "a", newString: "b" }, error: "oldString not found", time: { start: t0 + 5_000, end: t0 + 5_100 } },
        sessionID: "ses_1",
        messageID: "msg_002",
      },
      { id: "prt_014", type: "tool", callID: "call_3", tool: "read", state: { status: "completed", input: { filePath: `${ROOT}\\data\\memory\\MEMORY.md` }, output: "# Memory index\n- secret project notes", title: "MEMORY.md", metadata: {}, time: { start: 1, end: 2 } }, sessionID: "ses_1", messageID: "msg_002" },
      { id: "prt_015", type: "text", text: "Here is a fence:\n```js\nconsole.log(1)\n```\nDone.", time: { start: t0 + 6_000, end: t0 + 19_000 }, sessionID: "ses_1", messageID: "msg_002" },
      { id: "prt_016", type: "patch", hash: "deadbeef", files: [`${ROOT}\\src\\app.ts`], sessionID: "ses_1", messageID: "msg_002" },
      { id: "prt_017", type: "step-finish", reason: "stop", cost: 0, tokens: { input: 25_000, output: 1_200, reasoning: 300, cache: { read: 0, write: 0 } }, sessionID: "ses_1", messageID: "msg_002" },
    ],
  },
  { info: { id: "msg_000", role: "system" }, parts: [] },
]

const t = T.buildTranscript({ title: `Debug ${ROOT} build`, messages, answers, snapshotAt: t0 + 30_000, paths: { roots: [], homes: ["C:\\Users\\x"] }, secrets: { secrets: [FAKE.known] } })
const json = JSON.stringify(t)

check("format header and ordering", () => {
  eq(t.format, "syrup.transcript", "format")
  eq(t.version, 1, "version")
  eq(t.messages.length, 2, "system message dropped, two left")
  eq(t.messages[0].parts[0].id, "prt_001", "parts sorted by id")
})

check("no secrets and no absolute paths anywhere in the JSON", () => {
  for (const s of [FAKE.openai, FAKE.groq, "C:\\\\Users\\\\x", "C:/Users/x", "Users\\\\x\\\\syrup"]) assert(!json.includes(s), `found ${s}`)
  assert(t.stats.redactions >= 2, `redactions ${t.stats.redactions}`)
  assert(t.title === "Debug . build", `title ${t.title}`)
})

check("engine internals are not copied (system prompt, cwd, tool metadata, snapshots)", () => {
  assert(!json.includes("SYSTEM PROMPT OVERRIDE"), "system prompt leaked")
  assert(!json.includes("secretish"), "tool metadata leaked")
  assert(!json.includes("abc123") && !json.includes("deadbeef"), "snapshot/patch hashes leaked")
  assert(!/"cwd"|"root"/.test(json), "path info leaked")
})

check("memory index content is omitted", () => {
  assert(!json.includes("secret project notes"), "memory index leaked")
})

check("paths inside tool input, patch and file parts are workspace-relative", () => {
  const tool = t.messages[1].parts.find((p) => p.type === "tool" && p.tool === "edit")
  eq(tool.input.filePath, "src\\app.ts", "tool input")
  eq(tool.status, "error", "status")
  eq(t.messages[1].parts.find((p) => p.type === "patch").files[0], "src\\app.ts", "patch")
  const ref = t.messages[0].parts.find((p) => p.type === "file" && p.filename === "notes.md")
  eq(ref.omitted, "reference", "file reference")
  eq(ref.path, "notes.md", "reference path")
  assert(!ref.url, "file:// url kept")
})

check("attachments: small kept inline, over 1 MB left out", () => {
  const small = t.messages[0].parts.find((p) => p.filename === "shot.png")
  const big = t.messages[0].parts.find((p) => p.filename === "big.png")
  eq(small.url, smallPng, "small kept")
  assert(!big.url && big.omitted === "size", "big kept")
  eq(t.stats.attachmentsDropped, 1, "dropped count")
  assert(t.notes.some((n) => n.includes("attachment")), "no note about the dropped attachment")
})

check("stats, router answers and model labels", () => {
  eq(t.stats.messages, 2, "messages")
  eq(t.stats.toolCalls, 3, "tool calls")
  eq(t.stats.toolErrors, 1, "tool errors")
  eq(t.stats.reasoning, 1, "reasoning")
  eq(t.stats.tokens.input, 25_000, "tokens")
  const a = t.messages[1]
  eq(a.routed?.length, 1, "routed answers")
  assert(a.modelLabel?.startsWith("Auto → "), `label ${a.modelLabel}`)
  eq(t.models.length, 1, "models")
  assert(t.stats.bytes > 0 && t.stats.bytes === new TextEncoder().encode(JSON.stringify(t)).length, "bytes matches the JSON size")
})

check("Markdown: headings per turn, fenced tool blocks, safe fences, no secrets", () => {
  const md = T.renderMarkdown(t, { url: "https://example.com/c/abc" })
  assert(md.startsWith("# Debug . build"), "title heading")
  assert(md.includes("## 1. User") && md.includes("## 2. Assistant · Auto → "), "turn headings")
  assert(md.includes("### Tool: bash · completed"), "tool heading")
  assert(md.includes("```json\n{\n  \"command\""), "tool input fence")
  assert(md.includes("### Thinking"), "reasoning")
  assert(md.includes("Attached context:"), "synthetic context")
  assert(md.includes("https://example.com/c/abc/json"), "links")
  assert(!md.includes(FAKE.openai) && !md.includes(FAKE.groq), "secret in markdown")
  // Content with ``` inside a fenced block must use a longer fence.
  const inner = T.renderMarkdown({ ...t, messages: [{ ...t.messages[1], parts: [{ type: "tool", id: "x", tool: "bash", status: "completed", input: {}, output: "```\nnested\n```" }] }] })
  assert(inner.includes("````text\n```\nnested\n```\n````"), "fence not escalated")
})

check("clipForViewer hides attached context and clips long tool text", () => {
  const long = { ...t, messages: [{ ...t.messages[1], parts: [{ type: "tool", id: "x", tool: "bash", status: "completed", input: {}, output: "z".repeat(10_000) }] }, t.messages[0]] }
  const v = T.clipForViewer(long)
  assert(v.messages[0].parts[0].output.length < 7_000, "not clipped")
  assert(!v.messages[1].parts.some((p) => p.type === "text" && p.synthetic), "synthetic kept")
  eq(T.firstUserLine(t).startsWith("Fix the bug in src\\app.ts"), true, "first user line")
})

check("size cap: huge tool output is shortened to fit 5 MB", () => {
  const huge = [
    messages[0],
    { ...messages[1], parts: Array.from({ length: 3 }, (_, i) => ({ id: `prt_h${i}`, type: "tool", callID: `c${i}`, tool: "bash", state: { status: "completed", input: {}, output: "y".repeat(2_500_000), title: "", metadata: {}, time: { start: 1, end: 2 } } })) },
  ]
  const big = T.buildTranscript({ title: "huge", messages: huge })
  assert(big.stats.bytes <= T.MAX_SNAPSHOT_BYTES, `bytes ${big.stats.bytes}`)
  assert(big.notes.some((n) => n.includes("shortened")), "no note")
})

check("size cap: an impossible chat throws TranscriptTooLarge", () => {
  const impossible = [{ info: { id: "m", role: "user", time: { created: 1 } }, parts: [{ id: "p", type: "text", text: "w".repeat(6 * 1024 * 1024) }] }]
  let threw = false
  try {
    T.buildTranscript({ title: "x", messages: impossible })
  } catch (err) {
    threw = err instanceof T.TranscriptTooLarge
  }
  assert(threw, "did not throw TranscriptTooLarge")
})

check("debug bundle: router summary, tool errors, redacted logs", () => {
  const b = T.buildDebug({
    sessionId: "ses_1",
    transcript: t,
    events: [
      { ts: t0 + 2_000, alias: "auto", provider: "groq", model: "kimi", tier: "free", status: "rate_limited", httpStatus: 429, attempts: 1, latencyMs: 300, ttftMs: null, inputTokens: 0, outputTokens: 0, cost: 0, reason: "rpm", error: `429 for key ${FAKE.groq}`, retryAt: null },
      { ts: t0 + 9_000, alias: "auto", provider: "groq", model: "kimi", tier: "free", status: "ok", httpStatus: 200, attempts: 2, latencyMs: 5_000, ttftMs: 800, inputTokens: 25_000, outputTokens: 1_200, cost: 0, reason: "best", error: null, retryAt: null },
    ],
    logs: [{ ts: t0, level: "info", source: "engine", event: "prompt.sent", data: { dir: `${ROOT}\\src`, auth: `Bearer ${FAKE.jwt}` } }],
    paths: { roots: [ROOT] },
  })
  eq(b.router.summary.requests, 2, "requests")
  eq(b.router.summary.failed, 1, "failed")
  eq(b.toolErrors.length, 1, "tool errors")
  const s = JSON.stringify(b)
  assert(!s.includes(FAKE.groq) && !s.includes(FAKE.jwt) && !s.includes("Users\\\\x"), "debug bundle leaks")
  const md = T.renderDebugMarkdown(b)
  assert(md.includes("## Router") && md.includes("| time (UTC) |") && md.includes("## Tool errors"), "debug markdown sections")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
