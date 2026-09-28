"use client"

import { useState } from "react"
import type { Part, ToolPart } from "@/lib/oc"
import { fmtCost, fmtDuration, fmtTokens } from "@/lib/format"
import { Brew, Elapsed } from "./brew"
import { FileLink } from "./file-link"
import { Markdown } from "./markdown"
import { useReadOnly } from "./read-only"
import { useTypewriter } from "@/lib/use-typewriter"

/** Streamed answer text types out; the typewriter is its arrival animation, so it gets no fade. */
function TypedText({ text, live, end }: { text: string; live: boolean; end?: number }) {
  return (
    <div className="chat-text">
      <Markdown text={useTypewriter(text, live, end)} />
    </div>
  )
}

/** A shared snapshot shows text as it is: no typewriter, no timers. */
function StaticText({ text }: { text: string }) {
  return (
    <div className="chat-text">
      <Markdown text={text} />
    </div>
  )
}

/** Renders one message part. Unknown/structural parts render nothing. */
export function PartView({ part, streaming }: { part: Part; streaming: boolean }) {
  const ro = !!useReadOnly()
  switch (part.type) {
    case "text":
      return part.text ? ro ? <StaticText text={part.text} /> : <TypedText text={part.text} live={streaming} end={part.time?.end} /> : null
    case "reasoning":
      return <Reasoning text={part.text} done={!!part.time?.end || !streaming} ms={part.time?.end && part.time.start ? part.time.end - part.time.start : null} ro={ro} />
    case "tool":
      return <Tool part={part} live={streaming} ro={ro} />
    case "step-finish":
      return (
        <div className="mt-1 text-[11px] text-muted">
          {fmtTokens(part.tokens.input + part.tokens.output + part.tokens.reasoning)} tokens · {fmtCost(part.cost)}
        </div>
      )
    case "file":
      // A shared snapshot may leave a large attachment out; then only its name remains.
      return part.url ? (
        <a href={part.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2">
          📎 {part.filename ?? part.mime}
        </a>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2">📎 {part.filename ?? part.mime}</span>
      )
    case "patch":
      return (
        <div className="text-xs text-muted">
          Edited {part.files.length === 1 ? "" : `${part.files.length} files: `}
          {part.files.map((f, i) => (
            <span key={f}>
              {i > 0 && ", "}
              <FileLink path={f} className="font-mono text-ink-2" />
            </span>
          ))}
        </div>
      )
    case "retry":
      return <div className="text-xs text-warn">Retrying…</div>
    case "compaction":
      return <div className="my-2 border-t border-dashed border-line pt-2 text-center text-[11px] text-muted">Context compacted</div>
    default:
      return null
  }
}

function Reasoning({ text, done, ms, ro = false }: { text: string; done: boolean; ms: number | null; ro?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  const label = ms != null && ms >= 1000 ? `Thought for ${fmtDuration(ms)}` : "Thought"
  // Read-only: a native disclosure, so it opens before hydration and in the static HTML export.
  if (ro)
    return (
      <details className="group/think my-1">
        <summary className="flex w-fit list-none items-center gap-1.5 text-xs text-muted transition hover:text-ink-2 [&::-webkit-details-marker]:hidden">
          <Chevron open={false} className="group-open/think:rotate-180" />
          {label}
        </summary>
        <div className="mt-1.5 border-l-2 border-line pl-3 text-[13px] leading-relaxed text-ink-2 whitespace-pre-wrap">{text}</div>
      </details>
    )
  return (
    <div className="my-1">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs text-muted transition hover:text-ink-2">
        <Chevron open={open} />
        {done ? label : <Brew mood="think" timerAfter={0} />}
      </button>
      {open && <div className="mt-1.5 border-l-2 border-line pl-3 text-[13px] leading-relaxed text-ink-2 whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

const TOOL_LABEL: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Run",
  glob: "Find files",
  grep: "Search",
  list: "List",
  webfetch: "Fetch",
  todowrite: "Update plan",
  todoread: "Read plan",
  task: "Subagent",
  skill: "Skill",
  question: "Question",
}

/** What a running tool is doing, as a real step name. */
const TOOL_VERB: Record<string, string> = {
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  bash: "Running",
  glob: "Finding files",
  grep: "Searching",
  list: "Looking around",
  webfetch: "Fetching",
  todowrite: "Planning",
  todoread: "Checking the plan",
  task: "Handing off",
  skill: "Opening the recipe",
  question: "Asking",
}

const FILE_TOOLS = new Set(["read", "write", "edit", "list"])

/** The file or folder a read/write/edit/list call works on. */
function toolPath(part: ToolPart): string | null {
  if (!FILE_TOOLS.has(part.tool)) return null
  const input = part.state.input ?? {}
  const p = input.filePath ?? input.path
  return typeof p === "string" && p ? p : null
}

function toolSummary(part: ToolPart): string {
  const st = part.state
  if ("title" in st && st.title) return st.title
  const input = st.input ?? {}
  const first = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.description ?? input.query
  return typeof first === "string" ? first : ""
}

function Tool({ part, live, ro = false }: { part: ToolPart; live: boolean; ro?: boolean }) {
  const [open, setOpen] = useState(false)
  const st = part.state
  // A row seen mid-run gets a small ripple when it lands; rows loaded from history stay still.
  const [sawRun] = useState(st.status === "pending" || st.status === "running")
  const label = TOOL_LABEL[part.tool] ?? part.tool
  const summary = toolSummary(part)
  const file = toolPath(part)
  const finished = st.status === "completed" || st.status === "error"
  // Only animate while the message is still streaming; a row left running by an aborted turn goes quiet.
  const working = !finished && live
  const dot = st.status === "completed" ? "bg-ok" : st.status === "error" ? "bg-err" : "bg-line-2"
  const dur = "time" in st && st.time && "end" in st.time && st.time.end && st.time.start ? fmtDuration(st.time.end - st.time.start) : null
  const detail = (
    <div className="space-y-2 border-t border-line px-3 py-2">
      <Block title="Input" text={JSON.stringify(st.input, null, 2)} />
      {st.status === "completed" && <Block title="Output" text={st.output} />}
      {st.status === "error" && <Block title="Error" text={st.error} tone="err" />}
    </div>
  )

  // Read-only (shared snapshot, HTML export): a native disclosure that opens without JavaScript; file mentions are plain text.
  if (ro)
    return (
      <details className="group/tool rise my-1.5 overflow-hidden rounded-xl border border-line bg-surface/70 text-[13px]">
        <summary className="flex w-full cursor-pointer list-none items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
          <span className="flex shrink-0 items-center gap-2">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="font-medium text-ink">{label}</span>
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{summary || file}</span>
          {dur && <span className="shrink-0 text-[11px] text-muted">{dur}</span>}
          <Chevron open={false} className="group-open/tool:rotate-180" />
        </summary>
        {detail}
      </details>
    )

  return (
    <div className="rise my-1.5 overflow-hidden rounded-xl border border-line bg-surface/70 text-[13px]">
      {/* The whole row toggles; the button gives keyboard access and leaves the file link its own control. */}
      <div onClick={() => setOpen((v) => !v)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-2/60">
        <button type="button" aria-expanded={open} className="flex shrink-0 items-center gap-2 rounded-sm focus-visible:outline-1 focus-visible:outline-accent">
          {working ? (
            <Brew label={TOOL_VERB[part.tool] ?? label} timerAfter={0} className="font-medium" />
          ) : (
            <>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot} ${sawRun && finished ? "brew-pop" : ""}`} />
              <span className="font-medium text-ink">{label}</span>
            </>
          )}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
          {file ? (
            <FileLink path={file} className="max-w-full truncate align-bottom">
              {summary || undefined}
            </FileLink>
          ) : (
            summary
          )}
        </span>
        {dur && <span className="shrink-0 text-[11px] text-muted">{dur}</span>}
        {working && <Elapsed since={st.status === "running" ? st.time.start : undefined} className="shrink-0 text-[11px] text-muted" />}
        <Chevron open={open} />
      </div>
      {open && detail}
    </div>
  )
}

function Block({ title, text, tone }: { title: string; text: string; tone?: "err" }) {
  const clipped = text.length > 6000 ? text.slice(0, 6000) + "\n… (truncated)" : text
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">{title}</div>
      <pre className={`max-h-[320px] overflow-auto rounded-lg bg-code-bg p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap ${tone === "err" ? "text-err" : "text-ink-2"}`}>
        {clipped}
      </pre>
    </div>
  )
}

function Chevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 opacity-60 transition ${open ? "rotate-180" : ""} ${className}`}>
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
