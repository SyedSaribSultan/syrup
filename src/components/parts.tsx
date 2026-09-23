"use client"

import { useState } from "react"
import type { Part, ToolPart } from "@/lib/oc"
import { fmtCost, fmtDuration, fmtTokens } from "@/lib/format"
import { Markdown } from "./markdown"

/** Renders one message part. Unknown/structural parts render nothing. */
export function PartView({ part, streaming }: { part: Part; streaming: boolean }) {
  switch (part.type) {
    case "text":
      return part.text ? <Markdown text={part.text} /> : null
    case "reasoning":
      return <Reasoning text={part.text} done={!!part.time.end} />
    case "tool":
      return <Tool part={part} />
    case "step-finish":
      return (
        <div className="mt-1 text-[11px] text-muted">
          {fmtTokens(part.tokens.input + part.tokens.output + part.tokens.reasoning)} tokens · {fmtCost(part.cost)}
        </div>
      )
    case "file":
      return (
        <a href={part.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2">
          📎 {part.filename ?? part.mime}
        </a>
      )
    case "patch":
      return (
        <div className="text-xs text-muted">
          Edited {part.files.length} file{part.files.length === 1 ? "" : "s"}
        </div>
      )
    case "retry":
      return <div className="text-xs text-warn">Retrying…</div>
    case "compaction":
      return <div className="my-2 border-t border-dashed border-line pt-2 text-center text-[11px] text-muted">Context compacted</div>
    default:
      void streaming
      return null
  }
}

function Reasoning({ text, done }: { text: string; done: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="my-1">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs text-muted transition hover:text-ink-2">
        <Chevron open={open} />
        {done ? "Thought" : <span className="pulse">Thinking…</span>}
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

function toolSummary(part: ToolPart): string {
  const st = part.state
  if ("title" in st && st.title) return st.title
  const input = st.input ?? {}
  const first = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.description ?? input.query
  return typeof first === "string" ? first : ""
}

function Tool({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false)
  const st = part.state
  const label = TOOL_LABEL[part.tool] ?? part.tool
  const summary = toolSummary(part)
  const dot =
    st.status === "completed" ? "bg-ok" : st.status === "error" ? "bg-err" : st.status === "running" ? "bg-accent pulse" : "bg-muted pulse"
  const dur = "time" in st && "end" in st.time && st.time.end ? fmtDuration(st.time.end - st.time.start) : null

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-line bg-surface/70 text-[13px]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-2/60">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="shrink-0 font-medium text-ink">{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{summary}</span>
        {dur && <span className="shrink-0 text-[11px] text-muted">{dur}</span>}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          <Block title="Input" text={JSON.stringify(st.input, null, 2)} />
          {st.status === "completed" && <Block title="Output" text={st.output} />}
          {st.status === "error" && <Block title="Error" text={st.error} tone="err" />}
        </div>
      )}
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 opacity-60 transition ${open ? "rotate-180" : ""}`}>
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
