"use client"

import { useMemo, type ReactNode } from "react"
import { diffLines, mergeTurns, splitLines, turnsSignature, type EngineDiff, type SessionDiff } from "@/lib/diffs"
import { useOptionalEngine } from "@/lib/engine-store"
import { isWindowsPath } from "@/lib/file-actions"
import { usePanel } from "@/lib/panel"
import { Brew } from "./brew"
import { FileLink, useFileMenu } from "./file-link"

/**
 * Files the agent changed in a session, from the engine's snapshot diffs: the
 * header button (desktop), the count badge, and the Changes tab of the
 * workspace panel. On a phone, or in a pane under ~560px, the tab is a list
 * you drill into; wider, the list sits left of the diff.
 */

// ---- Diffs come with the messages already in the store: no extra request ----

type Turns = {
  /** Each user turn's file diffs, oldest first, from `info.summary.diffs` (written once the turn settles). */
  turns: EngineDiff[][]
  /** The engine took snapshots in this chat (step-start parts carry one); false in a folder that is not a git repository. */
  snapshots: boolean
  loaded: boolean
  /** Changes only when a summary changes (turnsSignature), unlike `turns`, which is rebuilt on every streamed part. */
  sig: string
}

function useTurns(sessionID: string | null): Turns {
  const engine = useOptionalEngine()
  const sm = sessionID ? engine?.messages[sessionID] : undefined
  return useMemo(() => {
    const turns: EngineDiff[][] = []
    let snapshots = false
    if (!sm) return { turns, snapshots, loaded: false, sig: "" }
    for (const id of sm.order) {
      const m = sm.byId[id]
      if (!m) continue
      if (m.info.role === "user" && m.info.summary?.diffs?.length) turns.push(m.info.summary.diffs as EngineDiff[])
      if (!snapshots) for (const p of m.parts) if (p.type === "step-start" && p.snapshot) snapshots = true
    }
    return { turns, snapshots, loaded: sm.loaded, sig: turnsSignature(turns) }
  }, [sm])
}

/**
 * The session's diff, one entry per file (null until the messages are loaded).
 * Merged again only when a turn's summary changes, not on every streamed token.
 */
function useDiffs(sessionID: string | null): SessionDiff[] | null {
  const { turns, loaded, sig } = useTurns(sessionID)
  // The signature stands in for `turns`: same signature, same merge result.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const diffs = useMemo(() => mergeTurns(turns), [sig])
  return loaded ? diffs : null
}

/** Fallback when the engine has no snapshot diff: files the agent wrote or edited, from the tool calls. */
function useTouched(sessionID: string | null): string[] {
  const engine = useOptionalEngine()
  const directory = engine?.directory ?? ""
  const sm = sessionID ? engine?.messages[sessionID] : undefined
  return useMemo(() => {
    // Patches and tool calls spell the same file differently (C:/a vs C:\a); keep one per file.
    const set = new Map<string, string>()
    const add = (f: string) => set.set(isWindowsPath(directory) ? f.replace(/\\/g, "/").toLowerCase() : f, f)
    if (!sm) return []
    for (const id of sm.order) {
      for (const p of sm.byId[id]?.parts ?? []) {
        if (p.type === "patch") for (const f of p.files) add(f)
        if (p.type === "tool" && (p.tool === "write" || p.tool === "edit")) {
          const fp = p.state.input?.filePath
          if (typeof fp === "string") add(fp)
        }
      }
    }
    return [...set.values()]
  }, [sm, directory])
}

export type ChangeCount = { files: number; additions: number; deletions: number; /** false: counted from tool calls, no line numbers */ lines: boolean }

/** Changed files and lines in a session, for badges. Falls back to the files the agent touched. */
export function useChangeCount(sessionID: string | null | undefined): ChangeCount {
  const diffs = useDiffs(sessionID ?? null)
  const touched = useTouched(sessionID ?? null)
  return useMemo(() => {
    if (diffs && diffs.length > 0) return { files: diffs.length, additions: diffs.reduce((n, d) => n + d.additions, 0), deletions: diffs.reduce((n, d) => n + d.deletions, 0), lines: true }
    return { files: touched.length, additions: 0, deletions: 0, lines: false }
  }, [diffs, touched])
}

/** Desktop header button: "Changes +12 −3". Opens the workspace panel on the Changes tab (again: closes it). */
export function ChangesButton({ sessionID }: { sessionID: string }) {
  const panel = usePanel()
  const c = useChangeCount(sessionID)
  if (!panel) return null
  const on = panel.open && panel.tab === "changes"
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => (on ? panel.setOpen(false) : panel.openTab("changes"))}
      title="Files the agent changed in this chat"
      className={`rounded-lg px-2 py-1 text-xs transition pointer-coarse:min-h-11 ${on ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
    >
      Changes
      <ChangeFigures c={c} />
    </button>
  )
}

/** Kept for the session header until it switches to ChangesButton. */
export const Changes = ChangesButton

export function ChangeFigures({ c, className = "ml-1.5" }: { c: ChangeCount; className?: string }) {
  if (c.lines)
    return (
      <span className={`tabular-nums ${className}`}>
        <span className="text-ok">+{c.additions}</span> <span className="text-err">−{c.deletions}</span>
      </span>
    )
  if (c.files > 0) return <span className={`tabular-nums text-muted ${className}`}>{c.files}</span>
  return null
}

/** The Changes tab of the workspace panel. */
export function ChangesTab() {
  const panel = usePanel()
  if (!panel?.sessionID) return <Calm>Start a chat, and the files it changes show up here.</Calm>
  return <ChangesView key={panel.sessionID} sessionID={panel.sessionID} />
}

function ChangesView({ sessionID }: { sessionID: string }) {
  const panel = usePanel()!
  const diffs = useDiffs(sessionID)
  const touched = useTouched(sessionID)
  const { snapshots } = useTurns(sessionID)
  const current = diffs?.find((d) => d.file === panel.diff) ?? null
  const totals = diffs?.reduce((a, d) => ({ add: a.add + d.additions, del: a.del + d.deletions }), { add: 0, del: 0 })
  // Split (list | diff) needs a desktop pane of 560px or more; otherwise the list drills into the diff.
  const split = "expanded:@[560px]:flex"

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1">
      <div className={`${current ? "hidden" : "flex"} min-h-0 w-full flex-col overflow-y-auto overscroll-contain py-1 ${split} expanded:@[560px]:w-[240px] expanded:@[560px]:shrink-0 expanded:@[560px]:border-r expanded:@[560px]:border-line`}>
        {!diffs && (
          <div className="px-3 py-2">
            <Brew mood="load" />
          </div>
        )}
        {diffs && diffs.length === 0 && touched.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">No file changes in this chat yet.</div>}
        {diffs && diffs.length === 0 && touched.length > 0 && (
          <>
            <div className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wider text-muted uppercase">Files touched</div>
            {touched.map((f) => (
              <div key={f} className="flex items-center truncate px-3 py-1 font-mono text-xs text-ink-2 pointer-coarse:min-h-11">
                <FileLink path={f} className="max-w-full truncate">
                  {f.split(/[\\/]/).pop()}
                </FileLink>
              </div>
            ))}
            <div className="px-3 pt-2 text-[11px] leading-snug text-muted">
              {snapshots ? (
                "Line changes show up once the turn settles."
              ) : (
                <>
                  This folder is not a git repository, so line changes are not tracked. Run <span className="font-mono">git init</span> in it to turn that on; Home has it already.
                </>
              )}
            </div>
          </>
        )}
        {diffs && diffs.length > 0 && totals && (
          <div className="px-3 pt-1.5 pb-1 text-[11px] text-muted">
            {diffs.length} file{diffs.length === 1 ? "" : "s"} · <span className="text-ok">+{totals.add}</span> <span className="text-err">−{totals.del}</span>
          </div>
        )}
        {diffs?.map((d) => (
          <DiffRow key={d.file} diff={d} active={panel.diff === d.file} onSelect={() => panel.showDiff(d.file)} />
        ))}
      </div>
      <div className={`${current ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col ${split}`}>
        {current ? <UnifiedDiff key={current.file} diff={current} wrap={panel.wrap} onWrap={() => panel.setWrap(!panel.wrap)} onBack={() => panel.showDiff(null)} /> : <Calm>Pick a file.</Calm>}
      </div>
    </div>
  )
}

function Calm({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">{children}</div>
}

/** Tap shows the diff; right-click, a long press or the ⋯ gives the file actions. */
function DiffRow({ diff, active, onSelect }: { diff: SessionDiff; active: boolean; onSelect(): void }) {
  const fm = useFileMenu(diff.file)
  const parts = diff.file.split(/[\\/]/)
  const name = parts.pop()
  const dir = parts.join("/")
  return (
    <div className={`group mx-1 flex items-center rounded-md transition ${active ? "bg-surface-2" : "hover:bg-surface-2/70"}`}>
      <button
        type="button"
        {...fm.press}
        onClick={onSelect}
        onContextMenu={fm.bind.onContextMenu}
        title={diff.file}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left text-xs outline-none [-webkit-touch-callout:none] focus-visible:underline pointer-coarse:min-h-11 pointer-coarse:text-[13px] pointer-coarse:select-none"
      >
        <span className="min-w-0 flex-1 truncate font-mono">
          <span className="text-ink-2">{name}</span>
          {dir && <span className="ml-1.5 text-muted">{dir}</span>}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums pointer-coarse:text-[11px]">
          <span className="text-ok">+{diff.additions}</span> <span className="text-err">−{diff.deletions}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          fm.openAt(r.left, r.bottom + 4, e.currentTarget)
        }}
        aria-label={`Actions for ${name}`}
        className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition hover:text-ink focus-visible:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
      >
        ⋯
      </button>
      {fm.ui}
    </div>
  )
}

type Line = ReturnType<typeof diffLines>[number]

/** Unchanged runs longer than 8 lines collapse to 3 lines of context each side. */
function collapse(rows: Line[]): (Line | { gap: number })[] {
  const shown: (Line | { gap: number })[] = []
  let run: Line[] = []
  const flush = (last: boolean) => {
    if (run.length > 8) {
      shown.push(...run.slice(0, 3), { gap: run.length - (last ? 3 : 6) }, ...(last ? [] : run.slice(-3)))
    } else shown.push(...run)
    run = []
  }
  for (const r of rows) {
    if (r.t === " ") run.push(r)
    else {
      flush(false)
      shown.push(r)
    }
  }
  flush(true)
  return shown
}

function UnifiedDiff({ diff, wrap, onWrap, onBack }: { diff: SessionDiff; wrap: boolean; onWrap(): void; onBack(): void }) {
  const shown = useMemo(() => collapse(diffLines(splitLines(diff.before), splitLines(diff.after))), [diff.before, diff.after])
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-line py-1 pr-2 pl-1 font-mono text-[11px] text-muted">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the list of changed files"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11 expanded:@[560px]:hidden"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 3 4.5 7l4 4" />
          </svg>
        </button>
        <span className="min-w-0 flex-1 truncate px-1 py-0.5">
          <FileLink path={diff.file}>{diff.file}</FileLink>
        </span>
        <span className="shrink-0 font-sans tabular-nums">
          <span className="text-ok">+{diff.additions}</span> <span className="text-err">−{diff.deletions}</span>
        </span>
        {/* Phones and tablets have this in the panel's ⋯. */}
        <button type="button" aria-pressed={wrap} onClick={onWrap} title="Wrap long lines" className={`ml-1 hidden shrink-0 rounded-md px-1.5 py-0.5 font-sans transition expanded:block ${wrap ? "bg-surface-2 text-ink" : "hover:bg-surface-2 hover:text-ink"}`}>
          Wrap
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <pre className={`p-2 font-mono text-[11.5px] leading-[1.5] ${wrap ? "" : "w-max min-w-full"}`}>
          {shown.map((r, i) =>
            "gap" in r ? (
              <div key={i} className="my-0.5 text-center text-[10px] text-muted">
                ··· {r.gap} unchanged lines ···
              </div>
            ) : (
              <div key={i} className={`px-1 ${wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre"} ${r.t === "+" ? "bg-ok/10 text-ink" : r.t === "-" ? "bg-err/10 text-ink-2 line-through decoration-err/40" : "text-ink-2"}`}>
                <span className="mr-2 select-none text-muted">{r.t}</span>
                {r.s}
              </div>
            ),
          )}
        </pre>
      </div>
    </>
  )
}
