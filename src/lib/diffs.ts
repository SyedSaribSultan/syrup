/**
 * Pure helpers for the Changes panel: turn the engine's per-turn file diffs
 * into one session-wide diff. No React, no server imports, so
 * scripts/test-diffs.mjs can run them as they are.
 *
 * OpenCode 1.18 keeps a session's diffs on each user message
 * (`info.summary.diffs`, written after the turn settles) and its
 * `/session/{id}/diff` answers [] unless asked about one user message. Each
 * entry carries a full-context unified `patch` (older builds sent `before` and
 * `after` text), so a turn's before and after text can be rebuilt from it.
 */

export type EngineDiff = {
  file: string
  additions: number
  deletions: number
  /** Unified diff with the whole file as context (OpenCode 1.18). */
  patch?: string
  status?: string
  /** Older engines: the two sides as text. */
  before?: string
  after?: string
}

/** What the panel renders: one entry per file over the whole session. */
export type SessionDiff = { file: string; before: string; after: string; additions: number; deletions: number }

export type Line = { t: " " | "+" | "-"; s: string }

/** The two sides of one engine diff, from `before`/`after` when present, else rebuilt from the full-context patch. */
export function sides(d: EngineDiff): { before: string; after: string } {
  if (typeof d.before === "string" && typeof d.after === "string") return { before: d.before, after: d.after }
  const before: string[] = []
  const after: string[] = []
  let inHunk = false
  for (const line of (d.patch ?? "").split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    const c = line[0]
    if (c === "+") after.push(line.slice(1))
    else if (c === "-") before.push(line.slice(1))
    else if (c === " ") {
      before.push(line.slice(1))
      after.push(line.slice(1))
    }
    // "\ No newline at end of file" and the patch's own trailing newline carry no file content.
  }
  return { before: before.join("\n"), after: after.join("\n") }
}

/** Lines of a file's text; empty text is no lines, not one empty line (`"".split` would say one). */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n")
}

/** Small line diff (LCS on lines). Fine for the file sizes an agent edits. */
export function diffLines(a: string[], b: string[]): Line[] {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    // Too big for the table; show whole-file replace.
    return [...a.map((s) => ({ t: "-" as const, s })), ...b.map((s) => ({ t: "+" as const, s }))]
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: Line[] = []
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

/**
 * One diff per file across the turns of a session, oldest turn first: the
 * file's text before its first change against its text after its last change,
 * so a line edited in three turns counts once. A file put back the way it was
 * drops out.
 */
export function mergeTurns(turns: readonly (readonly EngineDiff[])[]): SessionDiff[] {
  const files = new Map<string, { before: string; after: string }>()
  for (const turn of turns) {
    for (const d of turn) {
      const s = sides(d)
      const cur = files.get(d.file)
      files.set(d.file, { before: cur ? cur.before : s.before, after: s.after })
    }
  }
  const out: SessionDiff[] = []
  for (const [file, { before, after }] of files) {
    if (before === after) continue
    const lines = diffLines(splitLines(before), splitLines(after))
    let additions = 0
    let deletions = 0
    for (const l of lines) {
      if (l.t === "+") additions++
      else if (l.t === "-") deletions++
    }
    out.push({ file, before, after, additions, deletions })
  }
  return out
}

/** A cheap fingerprint of the turns, so the merge only reruns when a summary actually changed. */
export function turnsSignature(turns: readonly (readonly EngineDiff[])[]): string {
  return turns.map((t) => t.map((d) => `${d.file}:${d.additions}:${d.deletions}:${d.patch?.length ?? d.after?.length ?? 0}`).join(",")).join("|")
}
