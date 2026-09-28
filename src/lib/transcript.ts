import { fmtCost, fmtDuration, fmtTokens } from "./format"
import { aliasLabel, backendLabel, modelLabel, switchNote } from "./model-label"
import { providerName } from "./model-registry"
import { answersFor } from "./router-answers"
import type { Answer } from "./router-status"
import { normalizePaths, redactText, type PathOptions, type RedactOptions } from "./redact"

/**
 * syrup's one transcript format. Every way a chat leaves syrup goes through
 * here: public share links (/c/<id>, /c/<id>/md, /c/<id>/json), the owner's
 * debug link, local exports and `pnpm chat:export`. Pure (no React, no server
 * imports) so the server, the browser and the CLI bundle share it.
 *
 * Input is OpenCode's own message + parts shape, which is what the local
 * engine API returns and what the cloud keeps in messages.info / messages.parts.
 * Output is a whitelist: only the fields below are copied, so engine-internal
 * fields (the system prompt override, absolute cwd/root, tool metadata,
 * snapshot hashes) never reach a share. Every string goes through path
 * normalization and secret redaction first.
 *
 * JSON format "syrup.transcript" v1 (stable; new optional fields may be added):
 *   { format, version, title, createdAt, updatedAt, snapshotAt,   // epoch ms
 *     models: string[],                                         // labels, e.g. "Kimi K2 (Groq)"
 *     stats: { messages, userMessages, assistantMessages, toolCalls, toolErrors,
 *              attachments, attachmentsDropped, reasoning, redactions, tokens, cost, bytes },
 *     notes: string[],                                          // what was shortened or left out
 *     answers: Answer[],                                        // router requests behind Auto/Fast answers
 *     messages: [{ id, role, createdAt, completedAt?, agent?, provider?, model?, modelLabel?,
 *                  tokens?, cost?, finish?, error?, routed?: [...], switchNote?,
 *                  parts: [text | reasoning | tool | file | patch | subtask | agent | retry | compaction | step] }] }
 */

export const TRANSCRIPT_FORMAT = "syrup.transcript"
export const TRANSCRIPT_VERSION = 1
export const DEBUG_FORMAT = "syrup.debug"

/** Hard cap on one stored snapshot (JSON, UTF-8). */
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
/** One inline attachment (its data: URL) larger than this is left out. */
export const MAX_ATTACHMENT_BYTES = 1024 * 1024
/** All inline attachments of one snapshot together. */
export const MAX_ATTACHMENTS_TOTAL = 3 * 1024 * 1024

// ------------------------------------------------------------------ input (OpenCode shape, loosely typed: cloud rows are jsonb)

export type RawPart = { id: string; type: string } & Record<string, unknown>
export type RawMessage = { info: { id: string; role: string } & Record<string, unknown>; parts: RawPart[] }

// ------------------------------------------------------------------ output

export type TTime = { start?: number; end?: number }
export type TTokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
export type TFile = {
  mime: string
  filename?: string
  /** Workspace-relative path when the file came from the workspace. */
  path?: string
  /** data: URL (inline, within the size caps) or an http(s) URL. Absent when left out. */
  url?: string
  /** Size of the inline data, bytes. */
  bytes?: number
  /** Why there is no url: "size" = over the caps, "reference" = a workspace file mention (its text is in a synthetic part). */
  omitted?: "size" | "reference"
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export type TPart =
  | { type: "text"; id: string; text: string; synthetic?: boolean; ignored?: boolean; time?: TTime }
  | { type: "reasoning"; id: string; text: string; time?: TTime }
  | {
      type: "tool"
      id: string
      tool: string
      callId?: string
      status: ToolStatus
      title?: string
      input: unknown
      output?: string
      error?: string
      /** Unified diff for edit tools, when the engine recorded one. */
      diff?: string
      attachments?: TFile[]
      time?: TTime
    }
  | ({ type: "file"; id: string } & TFile)
  | { type: "patch"; id: string; files: string[] }
  | { type: "subtask"; id: string; agent?: string; description?: string; prompt?: string }
  | { type: "agent"; id: string; name: string }
  | { type: "retry"; id: string; attempt?: number; error?: string; time?: number }
  | { type: "compaction"; id: string; auto?: boolean }
  | { type: "step"; id: string; reason?: string; tokens?: TTokens; cost?: number }

export type TRouted = { provider: string; model: string; label: string; ttftMs: number | null; latencyMs: number; attempts: number; reason: string | null; partial?: boolean; ts: number }

export type TMessage = {
  id: string
  role: "user" | "assistant"
  createdAt: number
  completedAt?: number
  agent?: string
  provider?: string
  model?: string
  /** "Auto → Kimi K2 (Groq)", "Claude Sonnet 4.5 (Anthropic)". */
  modelLabel?: string
  tokens?: TTokens
  cost?: number
  finish?: string
  error?: string
  /** Router requests behind this answer (Auto/Fast), oldest first. */
  routed?: TRouted[]
  switchNote?: string
  parts: TPart[]
}

export type TStats = {
  messages: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolErrors: number
  attachments: number
  attachmentsDropped: number
  reasoning: number
  redactions: number
  tokens: TTokens
  cost: number
  bytes: number
}

export type Transcript = {
  format: typeof TRANSCRIPT_FORMAT
  version: typeof TRANSCRIPT_VERSION
  title: string
  createdAt: number
  updatedAt: number
  snapshotAt: number
  models: string[]
  stats: TStats
  notes: string[]
  answers: Answer[]
  messages: TMessage[]
}

export class TranscriptTooLarge extends Error {
  constructor(public bytes: number) {
    super(`This chat is too large to share (${Math.round(bytes / 1024 / 1024)} MB after leaving out attachments; the limit is ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB).`)
  }
}

// ------------------------------------------------------------------ helpers

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

function tokensOf(v: unknown): TTokens | undefined {
  const t = obj(v)
  if (!Object.keys(t).length) return undefined
  const c = obj(t.cache)
  return { input: num(t.input) ?? 0, output: num(t.output) ?? 0, reasoning: num(t.reasoning) ?? 0, cacheRead: num(c.read) ?? 0, cacheWrite: num(c.write) ?? 0 }
}

function timeOf(v: unknown): TTime | undefined {
  const t = obj(v)
  const start = num(t.start)
  const end = num(t.end)
  return start === undefined && end === undefined ? undefined : { ...(start !== undefined && { start }), ...(end !== undefined && { end }) }
}

function utf8Bytes(s: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length
  return s.length
}

/** Where a read of syrup's memory index would come from; its content is never published. */
const MEMORY_INDEX = /(^|[\\/])(\.syrup[\\/]MEMORY\.md|memory[\\/]MEMORY\.md)$/i

function errorText(e: unknown): string | undefined {
  if (!e) return undefined
  if (typeof e === "string") return e
  const o = obj(e)
  const data = obj(o.data)
  return str(data.message) ?? str(o.message) ?? str(o.name) ?? "Error"
}

type Sanitizer = { text(s: string): string; value(v: unknown, depth?: number): unknown; count(): number }

function sanitizer(paths: PathOptions, secrets: RedactOptions): Sanitizer {
  let count = 0
  const text = (s: string) => {
    const r = redactText(normalizePaths(s, paths), secrets)
    count += r.count
    return r.text
  }
  const value = (v: unknown, depth = 0): unknown => {
    if (depth > 20) return "[nested too deep]"
    if (typeof v === "string") return text(v)
    if (Array.isArray(v)) return v.map((x) => value(x, depth + 1))
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = value(x, depth + 1)
      return out
    }
    return v
  }
  return { text, value, count: () => count }
}

function fileOf(p: Record<string, unknown>, s: Sanitizer): TFile {
  const mime = str(p.mime) ?? "application/octet-stream"
  const url = str(p.url) ?? ""
  const source = obj(p.source)
  const out: TFile = { mime }
  const filename = str(p.filename)
  if (filename) out.filename = s.text(filename)
  const srcPath = str(source.path)
  if (srcPath) out.path = s.text(srcPath)
  if (url.startsWith("data:")) {
    out.url = url
    out.bytes = url.length
  } else if (/^https?:\/\//i.test(url)) {
    out.url = s.text(url)
  } else if (url.startsWith("file:")) {
    if (!out.path) out.path = s.text(url)
    out.omitted = "reference"
  }
  return out
}

function partOf(p: RawPart, s: Sanitizer): TPart | null {
  const id = String(p.id)
  switch (p.type) {
    case "text": {
      const text = str(p.text) ?? ""
      return { type: "text", id, text: s.text(text), ...(p.synthetic === true && { synthetic: true }), ...(p.ignored === true && { ignored: true }), ...(timeOf(p.time) && { time: timeOf(p.time) }) }
    }
    case "reasoning":
      return { type: "reasoning", id, text: s.text(str(p.text) ?? ""), ...(timeOf(p.time) && { time: timeOf(p.time) }) }
    case "tool": {
      const st = obj(p.state)
      const status = (["pending", "running", "completed", "error"] as const).find((x) => x === st.status) ?? "pending"
      const input = obj(st.input)
      const target = str(input.filePath) ?? str(input.path) ?? ""
      const memoryIndex = MEMORY_INDEX.test(target)
      const meta = obj(st.metadata)
      const out: Extract<TPart, { type: "tool" }> = { type: "tool", id, tool: str(p.tool) ?? "tool", status, input: s.value(st.input ?? {}) }
      const callId = str(p.callID)
      if (callId) out.callId = callId
      const title = str(st.title)
      if (title) out.title = s.text(title)
      const output = str(st.output)
      if (output !== undefined) out.output = memoryIndex ? "[syrup memory index omitted]" : s.text(output)
      const error = str(st.error)
      if (error !== undefined) out.error = s.text(error)
      const diff = str(meta.diff)
      if (diff && !memoryIndex) out.diff = s.text(diff)
      if (Array.isArray(st.attachments)) {
        const files = st.attachments.map((a) => fileOf(obj(a), s))
        if (files.length) out.attachments = files
      }
      const t = timeOf(st.time)
      if (t) out.time = t
      return out
    }
    case "file":
      return { type: "file", id, ...fileOf(p, s) }
    case "patch":
      return { type: "patch", id, files: (Array.isArray(p.files) ? p.files : []).filter((f): f is string => typeof f === "string").map((f) => s.text(f)) }
    case "subtask":
      return { type: "subtask", id, agent: str(p.agent), description: p.description ? s.text(String(p.description)) : undefined, prompt: p.prompt ? s.text(String(p.prompt)) : undefined }
    case "agent":
      return { type: "agent", id, name: str(p.name) ?? "" }
    case "retry":
      return { type: "retry", id, attempt: num(p.attempt), error: errorText(p.error) ? s.text(errorText(p.error)!) : undefined, time: num(obj(p.time).created) }
    case "compaction":
      return { type: "compaction", id, auto: p.auto === true }
    case "step-finish":
      return { type: "step", id, reason: str(p.reason), tokens: tokensOf(p.tokens), cost: num(p.cost) }
    default:
      // step-start and snapshot carry engine-internal hashes; unknown types are skipped.
      return null
  }
}

function attachmentsIn(t: Transcript): TFile[] {
  const out: TFile[] = []
  for (const m of t.messages)
    for (const p of m.parts) {
      if (p.type === "file") out.push(p)
      if (p.type === "tool" && p.attachments) out.push(...p.attachments)
    }
  return out
}

/** Size of the JSON as it stands (cheap; used while shortening). */
function size(t: Transcript): number {
  return utf8Bytes(JSON.stringify(t))
}

/** Sets stats.bytes to the exact size of the JSON that contains it (a fixed point: the number's own digits count). */
function measure(t: Transcript): number {
  let n = t.stats.bytes
  for (let i = 0; i < 6; i++) {
    t.stats.bytes = n
    const m = size(t)
    if (m === n) return n
    n = m
  }
  t.stats.bytes = n
  return n
}

function clip(text: string, max: number, what: string): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${what} shortened: ${text.length - max} more characters]` : text
}

/** Enforces the attachment caps and MAX_SNAPSHOT_BYTES, shortening in order of least value. Throws TranscriptTooLarge. */
function fit(t: Transcript): void {
  // Headroom for the stats written after shortening.
  const BUDGET = MAX_SNAPSHOT_BYTES - 4096
  const files = attachmentsIn(t).filter((f) => f.url?.startsWith("data:"))
  let dropped = 0
  let total = 0
  for (const f of [...files].sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0))) {
    const b = f.bytes ?? 0
    if (b > MAX_ATTACHMENT_BYTES || total + b > MAX_ATTACHMENTS_TOTAL) {
      delete f.url
      f.omitted = "size"
      dropped++
    } else total += b
  }
  if (size(t) > BUDGET) {
    for (const f of files.filter((f) => f.url).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))) {
      delete f.url
      f.omitted = "size"
      dropped++
      if (size(t) <= BUDGET) break
    }
  }
  if (dropped) t.notes.push(`${dropped} attachment${dropped === 1 ? " was" : "s were"} left out to keep the snapshot under the size limit.`)

  const steps: { max: number; what: string; apply(p: TPart, max: number): boolean }[] = [
    { max: 50_000, what: "tool output", apply: (p, max) => (p.type === "tool" && !!p.output && p.output.length > max ? ((p.output = clip(p.output, max, "output")), true) : false) },
    { max: 20_000, what: "attached context", apply: (p, max) => (p.type === "text" && !!p.synthetic && p.text.length > max ? ((p.text = clip(p.text, max, "attached context")), true) : false) },
    { max: 30_000, what: "diff", apply: (p, max) => (p.type === "tool" && !!p.diff && p.diff.length > max ? ((p.diff = clip(p.diff, max, "diff")), true) : false) },
    { max: 50_000, what: "reasoning", apply: (p, max) => (p.type === "reasoning" && p.text.length > max ? ((p.text = clip(p.text, max, "reasoning")), true) : false) },
    { max: 5_000, what: "tool output", apply: (p, max) => (p.type === "tool" && !!p.output && p.output.length > max ? ((p.output = clip(p.output, max, "output")), true) : false) },
  ]
  for (const step of steps) {
    if (size(t) <= BUDGET) break
    let n = 0
    for (const m of t.messages) for (const p of m.parts) if (step.apply(p, step.max)) n++
    if (n) t.notes.push(`${n} ${step.what}${n === 1 ? "" : "s"} longer than ${step.max.toLocaleString("en-US")} characters ${n === 1 ? "was" : "were"} shortened.`)
  }
  const bytes = size(t)
  if (bytes > BUDGET) throw new TranscriptTooLarge(bytes)
}

// ------------------------------------------------------------------ build

export type BuildInput = {
  title: string
  messages: RawMessage[]
  /** Router answers for the session (both modes: router_events). */
  answers?: Answer[] | null
  /** Session times; default to the first and last message. */
  createdAt?: number
  updatedAt?: number
  snapshotAt?: number
  /** Workspace roots and home folders to fold. Roots the messages report (path.root, path.cwd) are added automatically. */
  paths?: PathOptions
  /** Exact secrets and hidden strings, on top of the pattern rules. */
  secrets?: RedactOptions
}

/** Builds the normalized, sanitized transcript. Throws TranscriptTooLarge when even the shortened snapshot is over the cap. */
export function buildTranscript(input: BuildInput): Transcript {
  const roots = new Set(input.paths?.roots ?? [])
  for (const m of input.messages) {
    const p = obj(m.info.path)
    for (const k of ["root", "cwd"]) {
      const v = str(p[k])
      if (v && v !== "/" && v.length > 3) roots.add(v)
    }
  }
  const s = sanitizer({ roots: [...roots], homes: input.paths?.homes }, input.secrets ?? {})
  const answers = (input.answers ?? []).slice().sort((a, b) => a.ts - b.ts)

  const raw = input.messages
    .filter((m) => m.info && (m.info.role === "user" || m.info.role === "assistant"))
    .map((m) => ({ m, created: num(obj(m.info.time).created) ?? 0 }))
    .sort((a, b) => a.created - b.created || String(a.m.info.id).localeCompare(String(b.m.info.id)))

  const messages: TMessage[] = []
  const models: string[] = []
  const addModel = (l: string) => void (l && !models.includes(l) && models.push(l))
  const tokens: TTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let cost = 0

  for (const { m, created } of raw) {
    const info = m.info
    const role = info.role as "user" | "assistant"
    const parts = [...(m.parts ?? [])]
      .filter((p) => p && typeof p.id === "string")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => partOf(p, s))
      .filter((p): p is TPart => p !== null)
    const msg: TMessage = { id: String(info.id), role, createdAt: created, parts }
    const t = obj(info.time)
    const completed = num(t.completed)
    if (completed) msg.completedAt = completed
    const agent = str(info.agent) ?? str(info.mode)
    if (agent) msg.agent = agent
    if (role === "assistant") {
      const provider = str(info.providerID) ?? ""
      const model = str(info.modelID) ?? ""
      if (provider) msg.provider = provider
      if (model) msg.model = model
      const tk = tokensOf(info.tokens)
      if (tk) {
        msg.tokens = tk
        for (const k of Object.keys(tokens) as (keyof TTokens)[]) tokens[k] += tk[k]
      }
      const c = num(info.cost)
      if (c !== undefined) {
        msg.cost = c
        cost += c
      }
      const finish = str(info.finish)
      if (finish) msg.finish = finish
      const err = errorText(info.error)
      if (err) msg.error = s.text(err)
      if (provider === "syrup" && model) {
        const mine = answersFor(answers, model, created, completed ?? Number.POSITIVE_INFINITY)
        if (mine.length) {
          msg.routed = mine.map((a) => ({ provider: a.providerId, model: a.modelId, label: backendLabel(a), ttftMs: a.ttftMs, latencyMs: a.latencyMs, attempts: a.attempts, reason: a.reason, ts: a.ts, ...(a.partial && { partial: true }) }))
          const note = switchNote(mine, answers, created)
          if (note) msg.switchNote = note
          const final = mine[mine.length - 1]
          msg.modelLabel = `${aliasLabel(model)} → ${backendLabel(final)}`
          for (const a of mine) if (!a.partial || a === final) addModel(backendLabel(a))
        } else {
          msg.modelLabel = aliasLabel(model)
          addModel(aliasLabel(model))
        }
      } else if (model) {
        msg.modelLabel = provider ? `${modelLabel(model)} (${providerName(provider)})` : modelLabel(model)
        addModel(msg.modelLabel)
      }
    } else {
      const mm = obj(info.model)
      const provider = str(mm.providerID)
      const model = str(mm.modelID)
      if (provider) msg.provider = provider
      if (model) msg.model = model
    }
    messages.push(msg)
  }

  const first = messages[0]?.createdAt ?? Date.now()
  const lastMsg = messages[messages.length - 1]
  const last = lastMsg ? (lastMsg.completedAt ?? lastMsg.createdAt) : first
  const transcript: Transcript = {
    format: TRANSCRIPT_FORMAT,
    version: TRANSCRIPT_VERSION,
    title: s.text(input.title || "Untitled chat").slice(0, 300),
    createdAt: input.createdAt ?? first,
    updatedAt: input.updatedAt ?? last,
    snapshotAt: input.snapshotAt ?? Date.now(),
    models,
    stats: { messages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolErrors: 0, attachments: 0, attachmentsDropped: 0, reasoning: 0, redactions: 0, tokens, cost, bytes: 0 },
    notes: [],
    answers: answers.map((a) => ({ ts: a.ts, alias: a.alias, providerId: a.providerId, modelId: a.modelId, ttftMs: a.ttftMs, latencyMs: a.latencyMs, attempts: a.attempts, reason: a.reason, ...(a.inputTokens !== undefined && { inputTokens: a.inputTokens }), ...(a.partial && { partial: true }) })),
    messages,
  }
  fit(transcript)
  transcript.stats = { ...countStats(transcript), redactions: s.count(), tokens, cost, bytes: 0 }
  measure(transcript)
  return transcript
}

function countStats(t: Transcript): Omit<TStats, "redactions" | "tokens" | "cost" | "bytes"> {
  let toolCalls = 0
  let toolErrors = 0
  let reasoning = 0
  for (const m of t.messages)
    for (const p of m.parts) {
      if (p.type === "tool") {
        toolCalls++
        if (p.status === "error") toolErrors++
      }
      if (p.type === "reasoning" && p.text) reasoning++
    }
  const files = attachmentsIn(t)
  return {
    messages: t.messages.length,
    userMessages: t.messages.filter((m) => m.role === "user").length,
    assistantMessages: t.messages.filter((m) => m.role === "assistant").length,
    toolCalls,
    toolErrors,
    reasoning,
    attachments: files.filter((f) => f.omitted !== "size").length,
    attachmentsDropped: files.filter((f) => f.omitted === "size").length,
  }
}

/** The same transcript with long tool text cut to what the chat UI shows (the full text stays in /md and /json). */
export function clipForViewer(t: Transcript, max = 6_000): Transcript {
  const cut = (s: string | undefined) => (s && s.length > max ? `${s.slice(0, max)}\n… (truncated — the full text is in the Markdown and JSON versions)` : s)
  return {
    ...t,
    messages: t.messages.map((m) => ({
      ...m,
      parts: m.parts
        // Attached context is hidden in the chat UI; it stays in /md and /json.
        .filter((p) => !(p.type === "text" && p.synthetic))
        .map((p) => {
          if (p.type !== "tool") return p
          const input = JSON.stringify(p.input ?? {})
          return { ...p, input: input.length > max ? { note: `Input is ${input.length.toLocaleString("en-US")} characters; the full input is in the JSON version.` } : p.input, output: cut(p.output), error: cut(p.error), diff: undefined }
        }),
    })),
  }
}

// ------------------------------------------------------------------ Markdown

function fence(content: string, lang = ""): string {
  let run = 0
  for (const m of content.matchAll(/`+/g)) run = Math.max(run, m[0].length)
  const f = "`".repeat(Math.max(3, run + 1))
  return `${f}${lang}\n${content.replace(/\n$/, "")}\n${f}`
}

function utc(ms: number): string {
  if (!ms) return "unknown time"
  return `${new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "")} UTC`
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n")
}

function fileLine(f: TFile): string {
  const name = f.filename ?? f.path ?? f.mime
  const bits = [f.mime, f.bytes ? `${Math.round(f.bytes / 1024)} KB inline` : null, f.path && f.path !== name ? f.path : null, f.omitted === "size" ? "left out: over the size limit" : f.omitted === "reference" ? "workspace file" : null]
  return `- ${name} (${bits.filter(Boolean).join(", ")})`
}

function toolMarkdown(p: Extract<TPart, { type: "tool" }>): string {
  const dur = p.time?.start && p.time?.end ? ` · ${fmtDuration(p.time.end - p.time.start)}` : ""
  const out = [`### Tool: ${p.tool} · ${p.status}${dur}`, ""]
  if (p.title) out.push(`Title: ${p.title}`, "")
  if (p.callId) out.push(`Call: \`${p.callId}\``, "")
  out.push("Input:", "", fence(JSON.stringify(p.input ?? {}, null, 2), "json"), "")
  if (p.output !== undefined) out.push("Output:", "", fence(p.output || "(empty)", "text"), "")
  if (p.error !== undefined) out.push("Error:", "", fence(p.error || "(empty)", "text"), "")
  if (p.diff) out.push("Diff:", "", fence(p.diff, "diff"), "")
  if (p.attachments?.length) out.push("Attachments:", "", ...p.attachments.map(fileLine), "")
  return out.join("\n")
}

/** Clean, LLM-friendly Markdown: a header block, then one heading per message with its parts in order. */
export function renderMarkdown(t: Transcript, opts: { url?: string } = {}): string {
  const st = t.stats
  const lines: string[] = [`# ${t.title.replace(/\n/g, " ")}`, ""]
  const meta = [
    `Shared from syrup · snapshot ${utc(t.snapshotAt)}`,
    t.models.length ? `Models: ${t.models.join(", ")}` : null,
    `Messages: ${st.messages} (${st.userMessages} user, ${st.assistantMessages} assistant) · Tool calls: ${st.toolCalls}${st.toolErrors ? ` (${st.toolErrors} failed)` : ""} · Tokens: ${fmtTokens(st.tokens.input + st.tokens.output + st.tokens.reasoning)} · Cost: ${fmtCost(st.cost)}`,
    `Chat started ${utc(t.createdAt)} · last activity ${utc(t.updatedAt)}`,
    st.redactions ? `${st.redactions} secret${st.redactions === 1 ? "" : "s"} redacted as [redacted]. File paths are workspace-relative.` : "File paths are workspace-relative; secrets are redacted as [redacted].",
    ...t.notes,
    `Format: ${TRANSCRIPT_FORMAT} v${t.version}${opts.url ? ` · Markdown: ${opts.url}/md · JSON: ${opts.url}/json` : ""}`,
  ].filter((l): l is string => !!l)
  lines.push(...meta.map((l) => `> ${l}`), "", "---", "")

  t.messages.forEach((m, i) => {
    if (m.role === "user") {
      lines.push(`## ${i + 1}. User · ${utc(m.createdAt)}`, "")
      for (const p of m.parts) {
        if (p.type === "text" && !p.synthetic && p.text) lines.push(p.text, "")
      }
      const files = m.parts.filter((p): p is Extract<TPart, { type: "file" }> => p.type === "file")
      if (files.length) lines.push("Attachments:", "", ...files.map(fileLine), "")
      const ctx = m.parts.filter((p): p is Extract<TPart, { type: "text" }> => p.type === "text" && !!p.synthetic && !!p.text)
      for (const p of ctx) lines.push("Attached context:", "", fence(p.text, "text"), "")
      return
    }
    lines.push(`## ${i + 1}. Assistant${m.modelLabel ? ` · ${m.modelLabel}` : ""} · ${utc(m.createdAt)}`, "")
    const tk = m.tokens ? m.tokens.input + m.tokens.output + m.tokens.reasoning : 0
    const final = m.routed?.[m.routed.length - 1]
    const facts = [
      m.completedAt ? `took ${fmtDuration(m.completedAt - m.createdAt)}` : "unfinished",
      final?.ttftMs != null ? `${fmtDuration(final.ttftMs)} to first token` : null,
      tk ? `${fmtTokens(tk)} tokens` : null,
      m.cost !== undefined ? fmtCost(m.cost) : null,
      m.agent ? `agent ${m.agent}` : null,
      m.finish ? `finish ${m.finish}` : null,
    ].filter(Boolean)
    lines.push(`_${facts.join(" · ")}_`, "")
    if (m.switchNote) lines.push(`_Router: ${m.switchNote}._`, "")
    if (m.routed && m.routed.length > 1) {
      lines.push("Router requests:", "", ...m.routed.map((r) => `- ${r.label} · ${r.reason ?? "picked"} · ${r.attempts} attempt${r.attempts === 1 ? "" : "s"} · ${fmtDuration(r.latencyMs)}${r.ttftMs != null ? ` · ${fmtDuration(r.ttftMs)} to first token` : ""}${r.partial ? " · stream broke" : ""}`), "")
    }
    for (const p of m.parts) {
      switch (p.type) {
        case "text":
          if (p.text) lines.push(p.text, "")
          break
        case "reasoning":
          if (p.text) lines.push(`### Thinking${p.time?.start && p.time?.end ? ` (${fmtDuration(p.time.end - p.time.start)})` : ""}`, "", quote(p.text), "")
          break
        case "tool":
          lines.push(toolMarkdown(p))
          break
        case "file":
          lines.push("Attachment:", "", fileLine(p), "")
          break
        case "patch":
          if (p.files.length) lines.push("### Edited files", "", ...p.files.map((f) => `- \`${f}\``), "")
          break
        case "subtask":
          lines.push(`### Subagent${p.agent ? `: ${p.agent}` : ""}`, "", p.description ?? "", "", p.prompt ? fence(p.prompt, "text") : "", "")
          break
        case "retry":
          lines.push(`_Retry ${p.attempt ?? ""}${p.error ? `: ${p.error}` : ""}_`, "")
          break
        case "compaction":
          lines.push("_Context compacted._", "")
          break
        default:
          break
      }
    }
    if (m.error) lines.push("Error:", "", fence(m.error, "text"), "")
  })
  lines.push("---", "", "_Shared from syrup, a free-first coding agent. This is a snapshot: messages sent after it stay private._", "")
  return lines.join("\n").replace(/\n{3,}/g, "\n\n")
}

export function renderJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** The first line the user typed, for link previews. */
export function firstUserLine(t: Transcript, max = 160): string {
  for (const m of t.messages) {
    if (m.role !== "user") continue
    for (const p of m.parts) {
      if (p.type !== "text" || p.synthetic || !p.text.trim()) continue
      const line = p.text.trim().split("\n").find((l) => l.trim()) ?? ""
      return line.length > max ? `${line.slice(0, max - 1)}…` : line
    }
  }
  return ""
}

// ------------------------------------------------------------------ debug bundle (owner-only link, CLI --debug)

export type DebugRouterEvent = {
  ts: number
  alias: string
  provider: string
  model: string
  tier: string
  status: string
  httpStatus: number | null
  attempts: number
  latencyMs: number
  ttftMs: number | null
  inputTokens: number
  outputTokens: number
  cost: number
  reason: string | null
  error: string | null
  retryAt: number | null
}

export type DebugLog = { ts: number; level: string; source: string; event: string; data: unknown }

export type ToolError = { messageId: string; tool: string; callId?: string; title?: string; error: string; input: unknown; at?: number }

export type DebugBundle = {
  format: typeof DEBUG_FORMAT
  version: 1
  generatedAt: number
  expiresAt?: number
  share?: { id: string; createdAt: number; updatedAt: number }
  sessionId: string
  router: {
    summary: { requests: number; ok: number; failed: number; backends: { backend: string; requests: number; ok: number; failed: number; medianTtftMs: number | null; medianLatencyMs: number | null; reasons: Record<string, number> }[] }
    events: DebugRouterEvent[]
  }
  toolErrors: ToolError[]
  logs: DebugLog[]
  transcript: Transcript
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export function buildDebug(input: {
  sessionId: string
  transcript: Transcript
  events: DebugRouterEvent[]
  logs: DebugLog[]
  share?: DebugBundle["share"]
  expiresAt?: number
  generatedAt?: number
  paths?: PathOptions
  secrets?: RedactOptions
}): DebugBundle {
  const s = sanitizer(input.paths ?? {}, input.secrets ?? {})
  const events = [...input.events].sort((a, b) => a.ts - b.ts).map((e) => ({ ...e, error: e.error ? s.text(e.error) : null }))
  const byBackend = new Map<string, DebugRouterEvent[]>()
  for (const e of events) {
    const k = `${e.provider}/${e.model}`
    byBackend.set(k, [...(byBackend.get(k) ?? []), e])
  }
  const toolErrors: ToolError[] = []
  for (const m of input.transcript.messages)
    for (const p of m.parts)
      if (p.type === "tool" && p.status === "error") toolErrors.push({ messageId: m.id, tool: p.tool, callId: p.callId, title: p.title, error: p.error ?? "", input: p.input, at: p.time?.end ?? p.time?.start })
  return {
    format: DEBUG_FORMAT,
    version: 1,
    generatedAt: input.generatedAt ?? Date.now(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.share ? { share: input.share } : {}),
    sessionId: input.sessionId,
    router: {
      summary: {
        requests: events.length,
        ok: events.filter((e) => e.status === "ok").length,
        failed: events.filter((e) => e.status !== "ok").length,
        backends: [...byBackend.entries()].map(([backend, es]) => {
          const reasons: Record<string, number> = {}
          for (const e of es) if (e.reason) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1
          return {
            backend,
            requests: es.length,
            ok: es.filter((e) => e.status === "ok").length,
            failed: es.filter((e) => e.status !== "ok").length,
            medianTtftMs: median(es.map((e) => e.ttftMs).filter((x): x is number => x != null)),
            medianLatencyMs: median(es.map((e) => e.latencyMs)),
            reasons,
          }
        }),
      },
      events,
    },
    toolErrors,
    logs: input.logs.map((l) => ({ ...l, event: s.text(l.event), data: s.value(l.data) })),
    transcript: input.transcript,
  }
}

/** Markdown for the debug bundle: the router timeline and tool errors, then the transcript. */
export function renderDebugMarkdown(b: DebugBundle, opts: { url?: string } = {}): string {
  const lines = [`# Debug: ${b.transcript.title}`, "", `> Session \`${b.sessionId}\` · generated ${utc(b.generatedAt)}${b.expiresAt ? ` · link valid until ${utc(b.expiresAt)}` : ""}`, "", "## Router", ""]
  const sm = b.router.summary
  lines.push(`${sm.requests} requests · ${sm.ok} ok · ${sm.failed} failed`, "")
  for (const be of sm.backends) {
    lines.push(`- \`${be.backend}\`: ${be.requests} requests, ${be.ok} ok, ${be.failed} failed${be.medianTtftMs != null ? `, median ${be.medianTtftMs} ms to first token` : ""}${be.medianLatencyMs != null ? `, median ${be.medianLatencyMs} ms total` : ""}${Object.keys(be.reasons).length ? ` (${Object.entries(be.reasons).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`)
  }
  lines.push("", "| time (UTC) | alias | backend | status | http | tries | ttft ms | total ms | in/out tokens | reason | error |", "|---|---|---|---|---|---|---|---|---|---|---|")
  for (const e of b.router.events) {
    const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160)
    lines.push(`| ${cell(new Date(e.ts).toISOString().slice(11, 19))} | ${cell(e.alias)} | ${cell(`${e.provider}/${e.model}`)} | ${cell(e.status)} | ${cell(e.httpStatus)} | ${cell(e.attempts)} | ${cell(e.ttftMs)} | ${cell(e.latencyMs)} | ${cell(`${e.inputTokens}/${e.outputTokens}`)} | ${cell(e.reason)} | ${cell(e.error)} |`)
  }
  lines.push("", "## Tool errors", "")
  if (!b.toolErrors.length) lines.push("None.", "")
  for (const t of b.toolErrors) lines.push(`### ${t.tool}${t.title ? ` · ${t.title}` : ""}`, "", fence(JSON.stringify(t.input ?? {}, null, 2), "json"), "", fence(t.error, "text"), "")
  lines.push(`## Logs (${b.logs.length})`, "")
  if (b.logs.length) lines.push(fence(b.logs.map((l) => `${new Date(l.ts).toISOString()}  ${l.level.toUpperCase().padEnd(5)}  ${l.source.padEnd(9)}  ${l.event}${l.data !== undefined && l.data !== null ? `  ${JSON.stringify(l.data)}` : ""}`).join("\n"), "text"), "")
  lines.push("", renderMarkdown(b.transcript, opts))
  return lines.join("\n").replace(/\n{3,}/g, "\n\n")
}
