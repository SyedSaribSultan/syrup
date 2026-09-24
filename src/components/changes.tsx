"use client"

import { useEffect, useMemo, useState } from "react"
import { oc, type FileDiff } from "@/lib/oc"
import { useEngine } from "@/lib/engine-store"

/** Files the agent changed in this session, from the engine's snapshot diff. */
export function Changes({ sessionID }: { sessionID: string }) {
  const { directory, connection, status, messages } = useEngine()
  const [open, setOpen] = useState(false)
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const busy = status[sessionID]?.type === "busy"

  // Refresh when the panel is open and the agent goes idle.
  useEffect(() => {
    if (!open || busy) return
    let alive = true
    oc(directory, connection)
      .session.diff({ path: { id: sessionID } })
      .then((r) => alive && setDiffs(r.data ?? []))
      .catch(() => alive && setDiffs([]))
    return () => {
      alive = false
    }
  }, [open, busy, sessionID, directory, connection])

  const totals = diffs?.reduce((a, d) => ({ add: a.add + d.additions, del: a.del + d.deletions }), { add: 0, del: 0 })
  const current = diffs?.find((d) => d.file === active) ?? null

  // Fallback when the engine has no snapshot diff: files the agent wrote or edited, from the tool calls.
  const sm = messages[sessionID]
  const touched = useMemo(() => {
    const set = new Set<string>()
    if (!sm) return []
    for (const id of sm.order) {
      for (const p of sm.byId[id]?.parts ?? []) {
        if (p.type === "patch") for (const f of p.files) set.add(f)
        if (p.type === "tool" && (p.tool === "write" || p.tool === "edit")) {
          const fp = p.state.input?.filePath
          if (typeof fp === "string") set.add(fp)
        }
      }
    }
    return [...set]
  }, [sm])

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className={`rounded-lg px-2 py-1 text-xs transition ${open ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>
        Changes
        {diffs && diffs.length > 0 ? (
          <span className="ml-1.5 tabular-nums">
            <span className="text-ok">+{totals!.add}</span> <span className="text-err">−{totals!.del}</span>
          </span>
        ) : touched.length > 0 ? (
          <span className="ml-1.5 tabular-nums text-muted">{touched.length}</span>
        ) : null}
      </button>

      {open && (
        <div className="absolute top-full right-0 z-20 mt-2 flex max-h-[70vh] w-[min(760px,80vw)] overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          <div className="w-[240px] shrink-0 overflow-y-auto border-r border-line py-1">
            {!diffs && <div className="px-3 py-2 text-xs text-muted">Loading…</div>}
            {diffs && diffs.length === 0 && touched.length === 0 && <div className="px-3 py-3 text-xs text-muted">No file changes in this session.</div>}
            {diffs && diffs.length === 0 && touched.length > 0 && (
              <>
                <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted">Files touched</div>
                {touched.map((f) => (
                  <div key={f} className="truncate px-3 py-1 font-mono text-xs text-ink-2" title={f}>
                    {f.split(/[\\/]/).pop()}
                  </div>
                ))}
                <div className="px-3 pt-2 text-[10px] text-muted">No line diff available for this session.</div>
              </>
            )}
            {diffs?.map((d) => (
              <button key={d.file} type="button" onClick={() => setActive(d.file)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-surface-2 ${active === d.file ? "bg-surface-2" : ""}`} title={d.file}>
                <span className="min-w-0 flex-1 truncate font-mono text-ink-2">{d.file.split(/[\\/]/).pop()}</span>
                <span className="shrink-0 tabular-nums text-[10px]">
                  <span className="text-ok">+{d.additions}</span> <span className="text-err">−{d.deletions}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-auto">
            {current ? <UnifiedDiff before={current.before} after={current.after} file={current.file} /> : <div className="p-4 text-xs text-muted">Pick a file.</div>}
          </div>
        </div>
      )}
    </div>
  )
}

/** Small line diff (LCS on lines). Fine for the file sizes an agent edits. */
function diffLines(a: string[], b: string[]): { t: " " | "+" | "-"; s: string }[] {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    // Too big for the table; show whole-file replace.
    return [...a.map((s) => ({ t: "-" as const, s })), ...b.map((s) => ({ t: "+" as const, s }))]
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { t: " " | "+" | "-"; s: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: " ", s: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: a[i++] })
    else out.push({ t: "+", s: b[j++] })
  }
  while (i < n) out.push({ t: "-", s: a[i++] })
  while (j < m) out.push({ t: "+", s: b[j++] })
  return out
}

function UnifiedDiff({ before, after, file }: { before: string; after: string; file: string }) {
  const rows = diffLines(before.split("\n"), after.split("\n"))
  // Collapse long unchanged runs.
  const shown: ({ t: " " | "+" | "-"; s: string } | { gap: number })[] = []
  let run: { t: " " | "+" | "-"; s: string }[] = []
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
  return (
    <div>
      <div className="sticky top-0 border-b border-line bg-surface px-3 py-1.5 font-mono text-[11px] text-muted">{file}</div>
      <pre className="p-2 font-mono text-[11.5px] leading-[1.5]">
        {shown.map((r, i) =>
          "gap" in r ? (
            <div key={i} className="my-0.5 text-center text-[10px] text-muted">
              ··· {r.gap} unchanged lines ···
            </div>
          ) : (
            <div key={i} className={`px-1 whitespace-pre-wrap ${r.t === "+" ? "bg-ok/10 text-ink" : r.t === "-" ? "bg-err/10 text-ink-2 line-through decoration-err/40" : "text-ink-2"}`}>
              <span className="mr-2 select-none text-muted">{r.t}</span>
              {r.s}
            </div>
          ),
        )}
      </pre>
    </div>
  )
}
