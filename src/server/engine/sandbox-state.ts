/**
 * What a sandboxes row says about its engine, derived on read so every reader (open, caps, the relay, ingest) agrees.
 * Pure: no database, no platform calls. The row is only a record of the VM; these rules keep a stale row from being
 * believed: a lapsed start lease is not a start, and a session past its end estimate is not running.
 */

/** Sandbox auto-stops this long after the last heartbeat/extend. */
export const IDLE_MS = 10 * 60_000
/** Hobby sandboxes stop at 45 minutes per session regardless of extensions; the UI warns before that. */
export const SESSION_CAP_MS = 45 * 60_000
/** How long an opener holds "starting": longer than the open route may run (maxDuration 180 s), so only a dead opener's lease lapses. */
export const START_LEASE_MS = 200_000

export type EngineRow = {
  status: string
  startUntil: Date | null
  lastSessionStartedAt: Date | null
  lastSessionEndedAt: Date | null
  idleUntil: Date | null
  updatedAt: Date
}

/** True while the row's last engine session has not been accounted (no end recorded after its start). */
export function sessionOpen(row: EngineRow): boolean {
  return !!row.lastSessionStartedAt && (!row.lastSessionEndedAt || row.lastSessionEndedAt < row.lastSessionStartedAt)
}

/**
 * When an unaccounted session ended, or will end at the latest: the 45-minute cap, or the VM's idle timer as last set
 * (rows from before idle_until count from their last write), or now. An upper bound, never under.
 */
export function sessionEndEstimate(row: EngineRow, now = Date.now()): number {
  // A workspace that never started an engine has no session: nothing to estimate.
  if (!row.lastSessionStartedAt) return now
  const start = row.lastSessionStartedAt.getTime()
  const idle = row.idleUntil ? row.idleUntil.getTime() : Math.max(row.updatedAt.getTime(), start) + IDLE_MS
  return Math.min(now, start + SESSION_CAP_MS, idle)
}

/** A start under a lease that has not lapsed. */
export function starting(row: Pick<EngineRow, "status" | "startUntil">, now = Date.now()): boolean {
  return row.status === "starting" && !!row.startUntil && row.startUntil.getTime() > now
}

/** Whether the engine can still be up: a live start, or a running session whose end estimate is still ahead. */
export function engineLive(row: EngineRow, now = Date.now()): boolean {
  if (row.status === "starting") return starting(row, now)
  return row.status === "running" && sessionOpen(row) && sessionEndEstimate(row, Number.MAX_SAFE_INTEGER) > now
}

/** The status to show and count: "running" or "starting" only while engineLive, else "stopped". "error" stays. */
export function liveStatus(row: EngineRow, now = Date.now()): string {
  if (row.status !== "starting" && row.status !== "running") return row.status
  return engineLive(row, now) ? row.status : "stopped"
}
