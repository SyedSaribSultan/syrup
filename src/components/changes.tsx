"use client"

import { useMemo, type ReactNode } from "react"
import { diffLines, mergeTurns, splitLines, turnsSignature, type EngineDiff, type SessionDiff } from "@/lib/diffs"
import { useOptionalEngine } from "@/lib/engine-store"
import { isWindowsPath } from "@/lib/file-actions"
import { usePanel } from "@/lib/panel"
import { Brew } from "./brew"
import { FileLink, useFileMenu } from "./file-link"
import { Button, IconButton } from "./ui/s"

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
  // On = the secondary fill (what is open), off = ghost: the same toggle as Files beside it.
  return (
    <Button variant={on ? "secondary" : "ghost"} size="sm" aria-pressed={on} onClick={() => (on ? panel.setOpen(false) : panel.openTab("changes"))} title="Files the agent changed in this chat">
      Changes
      <ChangeFigures c={c} />
    </Button>
  )
}

/** Kept for the session header until it switches to ChangesButton. */
export const Changes = ChangesButton

/** Diff counts (03 B11): Code label-xs, additions in success, deletions in critical. Without line numbers, the file count. */
export function ChangeFigures({ c, className = "ml-1.5" }: { c: ChangeCount; className?: string }) {
  if (c.lines)
    return (
      <span className={`tabular-nums ${className}`}>
        <span className="s-diff-add">+{c.additions}</span> <span className="s-diff-del">−{c.deletions}</span>
      </span>
    )
  if (c.files > 0) return <span className={`s-count tabular-nums ${className}`}>{c.files}</span>
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
      <div className={`${current ? "hidden" : "flex"} min-h-0 w-full flex-col overflow-y-auto overscroll-contain p-2 ${split} expanded:@[560px]:w-[260px] expanded:@[560px]:shrink-0 expanded:@[560px]:border-r expanded:@[560px]:border-line`}>
        {!diffs && (
          <div className="px-3 py-2">
            <Brew mood="load" />
          </div>
        )}
        {diffs && diffs.length === 0 && touched.length === 0 && <p className="s-empty-line px-3 py-3">No file changes in this chat yet.</p>}
        {diffs && diffs.length === 0 && touched.length > 0 && (
          <>
            <p className="s-sidebar__label">Files touched</p>
            {/* pointer-coarse 44: a plain row around a FileLink, not an s- component (no library floor). */}
            {touched.map((f) => (
              <div key={f} className="flex min-h-9 items-center truncate px-3 font-mono text-sm text-ink-2 pointer-coarse:min-h-11">
                <FileLink path={f} className="max-w-full truncate">
                  {f.split(/[\\/]/).pop()}
                </FileLink>
              </div>
            ))}
            <div className="s-help px-3 pt-2">
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
          <p className="s-sidebar__label">
            {diffs.length} file{diffs.length === 1 ? "" : "s"} · <span className="s-diff-add">+{totals.add}</span> <span className="s-diff-del">−{totals.del}</span>
          </p>
        )}
        {diffs && diffs.length > 0 && (
          <ul className="s-rows">
            {diffs.map((d) => (
              <DiffRow key={d.file} diff={d} active={panel.diff === d.file} onSelect={() => panel.showDiff(d.file)} />
            ))}
          </ul>
        )}
      </div>
      <div className={`${current ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col ${split}`}>
        {current ? <UnifiedDiff key={current.file} diff={current} wrap={panel.wrap} onWrap={() => panel.setWrap(!panel.wrap)} onBack={() => panel.showDiff(null)} /> : <Calm>Pick a changed file to see its diff.</Calm>}
      </div>
    </div>
  )
}

function Calm({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center">
      <p className="s-empty-line">{children}</p>
    </div>
  )
}

/** Tap shows the diff; right-click, a long press or the ⋯ gives the file actions. */
function DiffRow({ diff, active, onSelect }: { diff: SessionDiff; active: boolean; onSelect(): void }) {
  const fm = useFileMenu(diff.file)
  const parts = diff.file.split(/[\\/]/)
  const name = parts.pop()
  const dir = parts.join("/")
  // A B9 sm row (36, r12): the file name in ink, its folder in Code faint, the diff counts at the right. The row shown
  // in the diff takes the pressed fill (aria-current), and ⋯ gives the file actions.
  return (
    <li className="s-row-item group">
      <button
        type="button"
        {...fm.press}
        onClick={onSelect}
        onContextMenu={fm.bind.onContextMenu}
        title={diff.file}
        aria-current={active ? "page" : undefined}
        className="s-row s-row--sm pr-12 [-webkit-touch-callout:none] pointer-coarse:select-none"
      >
        <span className="s-row__title flex-1">
          {name}
          {dir && <span className="s-row__meta ml-2">{dir}</span>}
        </span>
        <span className="shrink-0 tabular-nums">
          <span className="s-diff-add">+{diff.additions}</span> <span className="s-diff-del">−{diff.deletions}</span>
        </span>
      </button>
      <span className="s-row__actions">
        <IconButton
          icon="ellipsis"
          label={`Actions for ${name}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            fm.openAt(r.left, r.bottom + 4, e.currentTarget)
          }}
        />
      </span>
      {fm.ui}
    </li>
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
      {/* Path bar (03 B11): back (narrow), the file as a Code path, its diff counts, Wrap. */}
      <div className="s-pathbar flex shrink-0 items-center gap-2">
        <IconButton icon="arrow-left" label="Back to the list of changed files" onClick={onBack} className="expanded:@[560px]:hidden" />
        <span className="s-crumbs min-w-0 flex-1 truncate">
          <FileLink path={diff.file}>{diff.file}</FileLink>
        </span>
        <span className="shrink-0 tabular-nums">
          <span className="s-diff-add">+{diff.additions}</span> <span className="s-diff-del">−{diff.deletions}</span>
        </span>
        {/* Phones and tablets have this in the panel's ⋯. */}
        <Button variant={wrap ? "secondary" : "ghost"} size="sm" aria-pressed={wrap} onClick={onWrap} title="Wrap long lines" className="max-expanded:hidden">
          Wrap
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <pre className={`p-2 font-mono text-xs ${wrap ? "" : "w-max min-w-full"}`}>
          {shown.map((r, i) =>
            "gap" in r ? (
              <div key={i} className="s-meta my-1 text-center">
                {r.gap} unchanged lines
              </div>
            ) : (
              <div key={i} className={`px-1 ${wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre"} ${r.t === "+" ? "bg-ok-tone text-ink" : r.t === "-" ? "bg-err-tone text-ink-2 line-through" : "text-ink-2"}`}>
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
