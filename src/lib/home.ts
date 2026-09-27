/**
 * Home: the workspace every user has without picking anything.
 * - Local: a real folder, ~/syrup, created on first ask by /api/workspace/home.
 * - Cloud: a workspace row marked is_home (src/server/cloud/workspaces.ts ensureHome).
 */

let localHome: Promise<string | null> | null = null

/** Local mode only. Null when the folder cannot be created (the engine's own folder is used instead). */
export function localHomePath(): Promise<string | null> {
  localHome ??= fetch("/api/workspace/home", { cache: "no-store" })
    .then(async (r) => (r.ok ? ((await r.json()).path as string) : null))
    .catch(() => null)
    .then((p) => {
      if (!p) localHome = null
      return p
    })
  return localHome
}

export type OpenedSandbox = { baseUrl: string; authorization: string; directory: string; start: "cold" | "warm" | "hot"; ms: number; expiresAt: string | null }

type Opening = { promise: Promise<OpenedSandbox>; settledAt: number | null }
const opening = new Map<string, Opening>()
// Long enough for a prewarm to hand over its connection, short enough that a sandbox that idled out is not reused.
const REUSE_MS = 90_000

/**
 * Cloud: boots or wakes a workspace's sandbox. Callers share one request while
 * it runs, and a recent result is reused, so the background prewarm of Home
 * and the workspace view never open twice. `fresh` skips a settled result
 * (the engine behind it is gone).
 */
export function openSandbox(workspaceId: string, fresh = false): Promise<OpenedSandbox> {
  const hit = opening.get(workspaceId)
  if (hit && (hit.settledAt === null || (!fresh && Date.now() - hit.settledAt < REUSE_MS))) return hit.promise
  const entry: Opening = {
    settledAt: null,
    promise: fetch(`/api/workspaces/${workspaceId}/open`, { method: "POST" }).then(async (r) => {
      const j = (await r.json().catch(() => ({}))) as { connection?: OpenedSandbox; error?: string }
      if (!r.ok || !j.connection) throw new Error(j.error ?? `open failed (${r.status})`)
      return j.connection
    }),
  }
  opening.set(workspaceId, entry)
  entry.promise.then(
    () => (entry.settledAt = Date.now()),
    () => opening.get(workspaceId) === entry && opening.delete(workspaceId),
  )
  return entry.promise
}

/** Starts opening a sandbox in the background; nothing waits on it. */
export function prewarmSandbox(workspaceId: string): void {
  openSandbox(workspaceId).catch(() => {})
}
