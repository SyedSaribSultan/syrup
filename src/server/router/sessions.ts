import { createHash } from "node:crypto"
import type http from "node:http"

/**
 * Per-session routing memory: which backend a chat is stuck to (keeps the
 * provider's prompt cache warm and the model consistent), how long its
 * answers usually are, and whether it is escalated to "hard" (after repeated
 * tool failures, or after a hard opening turn was answered fast). Idle
 * sessions expire after 30 minutes; at most 2000 kept.
 */

export type SessionState = {
  key: string
  /** Candidate id the session is stuck to. */
  sticky: string | null
  stickyAt: number
  /** The session reached the sticky backend by failing over, not because it ranked first. */
  stickyByFallback: boolean
  /** EWMA of completion tokens per answer. */
  outEwma: number
  /** Hard (escalated) until then: repeated tool failures. */
  escalatedUntil: number
  /**
   * Hard (escalated) while a request carries at most this many user messages; 0 when not. A hard opening sets it to
   * its own count plus one: the opening turn and the user's next turn (policy.difficulty).
   */
  escalatedThroughUser: number
  lastSeen: number
}

const TTL_MS = 30 * 60_000
const CAP = 2000

type Msg = { role?: string; content?: unknown }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : "")).join("\n")
  return ""
}

/** The OpenCode session id when the engine sent one, else null. */
export function sessionHeader(req: http.IncomingMessage): string | null {
  const h = req.headers["x-session-affinity"] ?? req.headers["x-session-id"]
  const v = Array.isArray(h) ? h[0] : h
  return v ? String(v).slice(0, 200) : null
}

/** Session key: the engine's session header, else a short hash of the first system and first user message. */
export function sessionKey(header: string | null, messages: Msg[]): string {
  if (header) return header
  const sys = messages.find((m) => m.role === "system")
  const user = messages.find((m) => m.role === "user")
  const h = createHash("sha256").update(textOf(sys?.content).slice(0, 4000)).update("\u0000").update(textOf(user?.content).slice(0, 4000)).digest("hex")
  return `h_${h.slice(0, 16)}`
}

export class Sessions {
  private map = new Map<string, SessionState>()
  constructor(private now: () => number) {}

  /** Returns the session, creating it; refreshes LRU order and drops idle ones. */
  touch(key: string): SessionState {
    const t = this.now()
    let s = this.map.get(key)
    if (s && t - s.lastSeen > TTL_MS) s = undefined
    if (s) this.map.delete(key)
    else s = { key, sticky: null, stickyAt: 0, stickyByFallback: false, outEwma: 600, escalatedUntil: 0, escalatedThroughUser: 0, lastSeen: t }
    s.lastSeen = t
    this.map.set(key, s)
    if (this.map.size > CAP) this.prune(t)
    return s
  }

  private prune(t: number) {
    for (const [k, s] of this.map) {
      if (this.map.size <= CAP && t - s.lastSeen <= TTL_MS) break
      if (this.map.size > CAP || t - s.lastSeen > TTL_MS) this.map.delete(k)
    }
  }

  /**
   * A state that is never stored, for a request that must neither read nor change its chat's routing memory: a title
   * call shares the chat's session id, and on a chat using Fast it would otherwise make the chat sticky to its backend.
   * `outEwma` is what the ranking expects the request to write.
   */
  detached(key: string, outEwma: number): SessionState {
    return { key, sticky: null, stickyAt: 0, stickyByFallback: false, outEwma, escalatedUntil: 0, escalatedThroughUser: 0, lastSeen: this.now() }
  }

  /** `reason` is why this backend served the turn; a sticky repeat keeps the earlier reason. */
  stick(s: SessionState, candidateId: string, reason: string) {
    if (reason !== "sticky" || s.sticky !== candidateId) s.stickyByFallback = reason === "fallback"
    s.sticky = candidateId
    s.stickyAt = this.now()
  }

  recordOutput(s: SessionState, completionTokens: number) {
    if (!completionTokens) return
    const v = Math.min(8000, Math.max(50, completionTokens))
    s.outEwma = Math.round(0.7 * s.outEwma + 0.3 * v)
  }

  get size(): number {
    return this.map.size
  }

  stuck(): number {
    let n = 0
    for (const s of this.map.values()) if (s.sticky) n++
    return n
  }
}
