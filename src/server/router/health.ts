import type { Candidate } from "./backends"
import type { RouterEvent } from "./store"
import type { Classified, HeaderLearning } from "./upstream-errors"

/**
 * In-process knowledge about each backend: how fast it answers (peak-EWMA of
 * time to first token, and of decode speed the other way up: slowness is
 * learned at once and forgotten slowly), how often it fails, what it is
 * cooling down from, and limits learned from errors and headers. Lives as
 * long as the router process; seeded from the model registry's priors and
 * drifting back to them while a backend goes unused.
 */

/** TTFT grows with prompt size (prefill). 1.0 at a mid-size (~16K token) prompt, the registry's reference point. */
export function promptFactor(promptTokens: number): number {
  return 0.6 + Math.max(0, promptTokens) / 40_000
}

type Stats = {
  /** Size-normalised TTFT, ms (divide observations by promptFactor). */
  ttft: number
  tps: number
  err: number
  samples: number
  overloads: number
  badRequests: number
  lastUsed: number
  /** When ttft/tps/err were last decayed toward the priors. */
  decayedAt: number
}

export type Cool = { until: number; reason: string }

type Learned = {
  maxPrompt?: number
  maxPromptAt?: number
  tpm?: number
  remainingTokens?: number
  remainingTokensUntil?: number
  /** The model rejected a thinking/reasoning-effort parameter; requests go plain from now on. */
  noReasoningParam?: boolean
}

const PRIOR_ERR = 0.05
/**
 * Half-life of what samples say about a backend once they stop coming. A
 * demoted backend is rarely picked, so it would never get the successes that
 * recover its score; decaying toward the registry priors lets it back in.
 */
const DECAY_HALF_LIFE_MS = 10 * 60_000
/**
 * Decode speed drifts back to the prior far more slowly: a free endpoint's throughput is a property of the endpoint,
 * not of a bad minute (OpenRouter's Nemotron 3 Ultra :free decoded at ~10–18 tok/s all day on 2026-10-08, while the
 * 10-minute decay walked the estimate back to the paid 195 tok/s between turns).
 */
const TPS_DECAY_HALF_LIFE_MS = 60 * 60_000
/** A decode-speed sample needs this many streamed tokens over at least this long, or it is mostly noise. */
const TPS_MIN_TOKENS = 50
const TPS_MIN_MS = 200
/** A learned prompt cap is forgotten after this long, so one misread error cannot exclude a backend for good. */
const LEARNED_PROMPT_TTL_MS = 60 * 60_000

/** Failures that say something about the backend itself, worth replaying from a previous run. */
const REPLAY_FAILURES = new Set(["overloaded", "timeout", "error", "network", "empty"])

/** Candidate id and key scope as backends.ts builds them, from a recorded event. */
function idsOf(e: Pick<RouterEvent, "providerId" | "modelId" | "keyId">): { id: string; keyScope: string } {
  const tail = e.keyId ?? (e.providerId === "opencode" ? "public" : "env")
  return { id: `${e.providerId}/${e.modelId}#${tail}`, keyScope: `${e.providerId}#${tail}` }
}

export class Health {
  private stats = new Map<string, Stats>()
  private cool = new Map<string, Cool>()
  private learned = new Map<string, Learned>()
  private inflight = new Map<string, number>()
  /** Events from a previous run, replayed into a backend's stats the first time it is seen. */
  private replay = new Map<string, RouterEvent[]>()

  constructor(private now: () => number) {}

  private statsOf(c: Candidate): Stats {
    const t = this.now()
    let s = this.stats.get(c.id)
    if (!s) {
      s = { ttft: c.info.ttftMs, tps: c.info.tps, err: PRIOR_ERR, samples: 0, overloads: 0, badRequests: 0, lastUsed: 0, decayedAt: t }
      this.stats.set(c.id, s)
      const past = this.replay.get(c.id)
      if (past) {
        this.replay.delete(c.id)
        for (const e of past) {
          s.lastUsed = Math.max(s.lastUsed, e.ts)
          if (e.status === "ok" && e.ttftMs !== null) {
            this.ttftSample(s, e.ttftMs / promptFactor(e.inputTokens > 0 ? e.inputTokens : 16_000))
            // Decode speed, from a first attempt only: its latency runs from the request's start, so latency minus
            // first-token time is the decode time plus a little overhead (a slight underestimate of the speed).
            if (e.attempts === 1) this.tpsSample(s, e.outputTokens, e.latencyMs - e.ttftMs)
            s.err = 0.8 * s.err
            s.samples++
          } else if (e.reason && REPLAY_FAILURES.has(e.reason)) s.err = 0.8 * s.err + 0.2
        }
        // Age the replayed figures as if they had been observed when they happened.
        s.decayedAt = Math.min(t, s.lastUsed || t)
      }
      return s
    }
    if (t > s.decayedAt) {
      const w = 0.5 ** ((t - s.decayedAt) / DECAY_HALF_LIFE_MS)
      s.ttft = c.info.ttftMs + (s.ttft - c.info.ttftMs) * w
      s.tps = c.info.tps + (s.tps - c.info.tps) * 0.5 ** ((t - s.decayedAt) / TPS_DECAY_HALF_LIFE_MS)
      s.err = PRIOR_ERR + (s.err - PRIOR_ERR) * w
      s.decayedAt = t
    }
    // Consecutive-failure counters describe the current spell only.
    if (s.lastUsed && t - s.lastUsed > DECAY_HALF_LIFE_MS) {
      s.overloads = 0
      s.badRequests = 0
    }
    return s
  }

  // ---------------------------------------------------------------- predictions

  predictTtftMs(c: Candidate, promptTokens: number): number {
    return this.statsOf(c).ttft * promptFactor(promptTokens)
  }

  tps(c: Candidate): number {
    return Math.max(5, this.statsOf(c).tps)
  }

  errRate(c: Candidate): number {
    return this.statsOf(c).err
  }

  overloads(c: Candidate): number {
    return this.statsOf(c).overloads
  }

  // ---------------------------------------------------------------- samples

  /** Successful attempt: first-token time, and decode speed when enough tokens streamed. */
  success(c: Candidate, promptTokens: number, ttftMs: number | null, outTokens: number, genMs: number) {
    const s = this.statsOf(c)
    if (ttftMs !== null) this.ttftSample(s, ttftMs / promptFactor(promptTokens))
    this.tpsSample(s, outTokens, genMs)
    s.err = 0.8 * s.err
    s.samples++
    s.overloads = 0
    s.badRequests = 0
    s.lastUsed = this.now()
  }

  /** Failed attempt. Timeouts also count as a (lower-bound) TTFT observation. */
  failure(c: Candidate, cls: Classified, promptTokens: number, waitedMs: number | null) {
    const s = this.statsOf(c)
    s.lastUsed = this.now()
    if (cls.reason === "timeout" && waitedMs !== null) this.ttftSample(s, waitedMs / promptFactor(promptTokens))
    if (cls.unhealthy) s.err = 0.8 * s.err + 0.2
    s.overloads = cls.reason === "overloaded" ? s.overloads + 1 : 0
    s.badRequests = cls.reason === "bad_request" ? s.badRequests + 1 : 0
  }

  /**
   * An attempt the router cut before its first token by its own choice (a lost hedge race, a title call's leash).
   * The wait is a lower bound on the backend's first-token time and says nothing about its health: it can only raise
   * the estimate, and it leaves the error rate, the failure counters and the cooldowns alone.
   */
  firstTokenAfter(c: Candidate, promptTokens: number, waitedMs: number) {
    const s = this.statsOf(c)
    s.lastUsed = this.now()
    const normMs = waitedMs / promptFactor(promptTokens)
    if (normMs > s.ttft) this.ttftSample(s, normMs)
  }

  /** Peak-EWMA: jump most of the way to slow observations, recover slowly from fast ones. */
  private ttftSample(s: Stats, normMs: number) {
    s.ttft = normMs > s.ttft ? 0.35 * s.ttft + 0.65 * normMs : 0.75 * s.ttft + 0.25 * normMs
  }

  /**
   * Decode speed, the same way round: a slower answer moves the estimate most of the way down at once (one 10 tok/s
   * answer takes a 195 tok/s prior to ~75, where the old plain average stopped at ~102), a faster one only a quarter
   * of the way up.
   */
  private tpsSample(s: Stats, outTokens: number, genMs: number) {
    if (!(outTokens >= TPS_MIN_TOKENS && genMs >= TPS_MIN_MS)) return
    const tps = outTokens / (genMs / 1000)
    s.tps = tps < s.tps ? 0.35 * s.tps + 0.65 * tps : 0.75 * s.tps + 0.25 * tps
  }

  // ---------------------------------------------------------------- memory from a previous run

  /**
   * Replays attempts another router process recorded (RouterStore.recent):
   * cooldowns still in force are applied now; first-token times, decode
   * speeds and failures join each backend's stats when that backend is first seen. A router that
   * just started in a fresh sandbox then knows what was overloaded or slow a
   * minute ago instead of finding out on the user's first message.
   */
  seed(events: readonly RouterEvent[]): { cooldowns: number; backends: number } {
    const t = this.now()
    let cooldowns = 0
    for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
      const { id, keyScope } = idsOf(e)
      if (e.retryAt !== null && e.retryAt > t) {
        const key = e.reason === "auth" || e.httpStatus === 402 ? `k:${keyScope}` : `b:${id}`
        const prev = this.cool.get(key)
        if (!prev || prev.until < e.retryAt) {
          this.cool.set(key, { until: e.retryAt, reason: e.reason ?? "error" })
          cooldowns++
        }
      }
      if ((e.status === "ok" && e.ttftMs !== null) || (e.reason && REPLAY_FAILURES.has(e.reason))) {
        if (this.stats.has(id)) continue
        const list = this.replay.get(id) ?? []
        list.push(e)
        this.replay.set(id, list)
      }
    }
    return { cooldowns, backends: this.replay.size }
  }

  // ---------------------------------------------------------------- cooldowns

  private coolKeys(c: Candidate): string[] {
    const keys = [`b:${c.id}`, `k:${c.keyScope}`]
    if (c.freeModel) keys.push(`kf:${c.keyScope}`)
    return keys
  }

  /** Epoch ms until which the candidate is skipped, with why; null when usable. */
  coolingUntil(c: Candidate): Cool | null {
    const t = this.now()
    let best: Cool | null = null
    for (const k of this.coolKeys(c)) {
      const v = this.cool.get(k)
      if (!v) continue
      if (v.until <= t) {
        this.cool.delete(k)
        continue
      }
      if (!best || v.until > best.until) best = v
    }
    return best
  }

  /** Applies a classified failure's cooldown. Returns the retryAt actually set (null when none). */
  applyCooldown(c: Candidate, cls: Classified): number | null {
    if (cls.scope === "none" || cls.retryAt === null) return null
    const key = cls.scope === "backend" ? `b:${c.id}` : cls.scope === "key" ? `k:${c.keyScope}` : `kf:${c.keyScope}`
    const prev = this.cool.get(key)
    if (!prev || prev.until < cls.retryAt) this.cool.set(key, { until: cls.retryAt, reason: cls.reason })
    return cls.retryAt
  }

  /** Too many identical request rejections in a row usually means the model cannot take this kind of request at all. */
  coolRepeatedBadRequests(c: Candidate): number | null {
    const s = this.statsOf(c)
    if (s.badRequests < 3) return null
    const until = this.now() + 10 * 60_000
    this.cool.set(`b:${c.id}`, { until, reason: "bad_request" })
    s.badRequests = 0
    return until
  }

  // ---------------------------------------------------------------- learned limits

  learn(c: Candidate, cls: Classified) {
    const l = this.learned.get(c.id) ?? {}
    if (cls.learnedMaxPrompt) {
      l.maxPrompt = Math.min(this.learnedMaxPrompt(c) ?? Infinity, cls.learnedMaxPrompt)
      l.maxPromptAt = this.now()
    }
    if (cls.learnedTpm) l.tpm = cls.learnedTpm
    if (cls.learnedNoReasoningParam) l.noReasoningParam = true
    this.learned.set(c.id, l)
  }

  noReasoningParam(c: Candidate): boolean {
    return !!this.learned.get(c.id)?.noReasoningParam
  }

  /** Success headers. Returns the cooldown set when the request budget is exhausted ("rpd" when it lasts over an hour). */
  learnHeaders(c: Candidate, h: HeaderLearning): Cool | null {
    const l = this.learned.get(c.id) ?? {}
    if (h.limitTokens && h.limitTokens > 0) l.tpm = h.limitTokens
    if (h.remainingTokens !== undefined && h.resetTokensAt) {
      l.remainingTokens = h.remainingTokens
      l.remainingTokensUntil = h.resetTokensAt
    }
    this.learned.set(c.id, l)
    const t = this.now()
    if (h.remainingRequests === 0 && h.resetRequestsAt && h.resetRequestsAt > t) {
      const until = Math.min(h.resetRequestsAt, t + 24 * 3600_000)
      const cool = { until, reason: until - t > 3600_000 ? "rpd" : "rpm" }
      this.cool.set(`b:${c.id}`, cool)
      return cool
    }
    return null
  }

  learnedMaxPrompt(c: Candidate): number | undefined {
    const l = this.learned.get(c.id)
    if (l?.maxPrompt === undefined) return undefined
    if (this.now() - (l.maxPromptAt ?? 0) > LEARNED_PROMPT_TTL_MS) {
      l.maxPrompt = undefined
      return undefined
    }
    return l.maxPrompt
  }

  learnedTpm(c: Candidate): number | undefined {
    return this.learned.get(c.id)?.tpm
  }

  /** Tokens left in the current minute when a header told us, else undefined. */
  remainingTokens(c: Candidate): { n: number; until: number } | undefined {
    const l = this.learned.get(c.id)
    if (l?.remainingTokens === undefined || !l.remainingTokensUntil || l.remainingTokensUntil <= this.now()) return undefined
    return { n: l.remainingTokens, until: l.remainingTokensUntil }
  }

  // ---------------------------------------------------------------- in-flight

  busy(c: Candidate): boolean {
    return (this.inflight.get(c.keyScope) ?? 0) > 0
  }

  begin(c: Candidate) {
    this.inflight.set(c.keyScope, (this.inflight.get(c.keyScope) ?? 0) + 1)
  }

  end(c: Candidate) {
    const n = (this.inflight.get(c.keyScope) ?? 1) - 1
    if (n <= 0) this.inflight.delete(c.keyScope)
    else this.inflight.set(c.keyScope, n)
  }

  // ---------------------------------------------------------------- debug

  snapshot() {
    const t = this.now()
    const cooldowns = [...this.cool.entries()].filter(([, v]) => v.until > t).map(([scope, v]) => ({ scope, until: v.until, inMs: v.until - t, reason: v.reason }))
    const health = [...this.stats.entries()]
      .filter(([, s]) => s.samples > 0 || s.lastUsed > 0)
      .map(([id, s]) => ({ id, ttftMs: Math.round(s.ttft), tps: Math.round(s.tps), errRate: Number(s.err.toFixed(3)), samples: s.samples, overloads: s.overloads, lastUsed: s.lastUsed }))
    const learned = [...this.learned.entries()].map(([id, l]) => ({ id, ...l }))
    return { cooldowns, health, learned, inflight: Object.fromEntries(this.inflight) }
  }
}
