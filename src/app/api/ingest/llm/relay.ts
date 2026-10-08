import { promisify } from "node:util"
import { gunzip } from "node:zlib"
import type { Catalog } from "../../../../server/router/store"
import { classifyFailure, RELAY_ERROR_HEADER, type RelayErrorKind } from "../../../../server/router/upstream-errors"
import { checkPolicy, UsageSniffer } from "./policy"

/**
 * syrup's cloud LLM relay, the logic behind /api/ingest/llm/<provider>/<path>.
 *
 * The router runs inside the workspace sandbox (sidecar/), but the user's raw
 * provider keys never enter it. The sidecar sends every provider call here
 * with its ingest token as the bearer; this module checks the token and its
 * sandbox session, looks up the user's active key for that provider, applies
 * the spend policy (./policy.ts), and calls the provider's fixed base URL with
 * the real key, streaming the answer back unbuffered.
 *
 * Every answer the provider did not write carries x-syrup-relay-error, so the
 * router never holds an app-side failure against a provider (upstream-errors.ts).
 *
 * Pure: no Next.js and no database imports, so scripts/test-llm-proxy.mjs can
 * bundle it. The route file (llm/[provider]/[...path]/route.ts) wires in the
 * token check, the key lookup, the catalog and the provider map. This file is
 * not a route.
 */

const gunzipAsync = promisify(gunzip)

/** The only provider paths the relay calls, each with its one method. Matched exactly. */
export const RELAY_ROUTES: Readonly<Record<string, "GET" | "POST">> = Object.freeze({ "chat/completions": "POST", models: "GET" })

/** The key id the sidecar's router has on record for this provider. The relay never uses another key without reading the database first. */
export const EXPECT_KEY_HEADER = "x-syrup-expect-key"

/**
 * Response headers passed back: exactly the ones the router learns from
 * (core.ts KEPT_HEADERS). Nothing else of the provider's reaches the sandbox:
 * no set-cookie, and no content-encoding or content-length, since fetch has
 * already decoded the body.
 */
const PASS_BACK = [
  "content-type",
  "retry-after",
  "x-request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]

/**
 * Request headers passed on, besides the real key and the content type.
 * OpenRouter reads http-referer and x-title; Fireworks reads x-session-affinity
 * (core.ts outboundHeaders). Cookies, x-forwarded-*, x-vercel-*, x-syrup-* and
 * the ingest token never reach a provider.
 */
const PASS_ON = ["accept", "http-referer", "x-title", "x-session-affinity"]

/** Raw request body cap. Vercel already refuses bodies over 4.5 MB before the function runs; this bounds everywhere else. */
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** Cap on a gzip request body once inflated, so a small compressed body cannot balloon in memory. */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024
/** Rejected key ids remembered per user and provider (a provider 401), at most. */
const MAX_REJECTED = 2_000

/** `s`: the sandbox session the token was minted for (the engine start, epoch ms). */
export type RelayClaims = { u: string; w: string; s?: number }
export type RelayKeyInfo = { id: string; secret: string; tier: "free" | "paid" }
/** One workspace's sandbox as the database last said: when its engine started, and whether it may still be running. */
export type RelaySession = { startedAt: number | null; live: boolean }
/** Everything the relay needs about one user, loaded in one database read and cached per instance. */
export type RelaySnapshot = { keys: ReadonlyMap<string, RelayKeyInfo>; sessions: ReadonlyMap<string, RelaySession> }
/** `hit`: served from this instance's cache (no database work in this request). `ageMs`: how old that read is. */
export type RelayLookup = { value: RelaySnapshot; hit: boolean; ageMs: number }
export type RelayLog = (event: string, data: Record<string, unknown>, level?: "info" | "warn" | "error") => void

export type RelayDeps = {
  /** Ingest token → claims, or null when it is missing, forged or expired. */
  verify: (token: string) => RelayClaims | null
  /**
   * The user's keys and sandbox sessions. `reload`: read the database now unless the cached read is
   * under a second old (KeyCache.reload). May throw (database down, or a read slower than its timeout).
   */
  lookup: (userId: string, opts?: { reload?: boolean }) => Promise<RelayLookup>
  /** The app's own models.dev catalog (policy.ts CatalogCache). Without it, paid keys are refused. */
  catalog?: { peek(): Catalog | null; get(): Promise<Catalog> }
  /** provider id → the provider's real OpenAI-compatible base URL (backends.ts BASE_URL). */
  baseURL: Readonly<Record<string, string>>
  fetch?: typeof fetch
  /** Monotonic ms clock, for timings. */
  now?: () => number
  /** A streaming answer still running this long after the request arrived is closed cleanly (maxDuration minus a margin). */
  deadlineMs: number
  log?: RelayLog
}

/** Error answers in the OpenAI shape the router's errorObject() reads, marked as the relay's own. Never carries a key or the token. */
function fail(status: number, kind: RelayErrorKind, type: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { type, message } }, { status, headers: { "cache-control": "no-store", [RELAY_ERROR_HEADER]: kind, ...headers } })
}

/** Reads a request body, or null once it passes `cap` bytes. */
async function readCapped(req: Request, cap: number): Promise<Buffer | null> {
  if (!req.body) return Buffer.alloc(0)
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > cap) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  return Buffer.concat(parts)
}

function causeOf(err: unknown): string {
  if (err instanceof Error) return (err.cause instanceof Error ? err.cause.message : err.message).slice(0, 200)
  return String(err).slice(0, 200)
}

const ms = (v: number) => Math.max(0, v).toFixed(1)
const NO_BODY = new Set([101, 103, 204, 205, 304])

/**
 * Builds the relay handler. `path` is the route's catch-all segments, already
 * decoded (Next decodes params). The upstream URL is built only from the fixed
 * base URL and an allow-listed suffix; the request's own query string is never
 * forwarded.
 */
export function createRelay(deps: RelayDeps) {
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const now = deps.now ?? (() => performance.now())
  const log: RelayLog = deps.log ?? (() => {})
  /** user + provider → the key id the provider last rejected. The next call for that provider re-reads the database first. */
  const rejected = new Map<string, string>()

  return async function relay(req: Request, provider: string, path: string[]): Promise<Response> {
    const t0 = now()

    // 1. The token. Nothing else is looked at, and no key is read, before it checks out.
    const authz = req.headers.get("authorization") ?? ""
    const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : ""
    let claims: RelayClaims | null = null
    try {
      claims = token ? deps.verify(token) : null
    } catch (err) {
      log("relay.verify_failed", { message: causeOf(err) }, "error")
      return fail(503, "unavailable", "syrup_relay_unavailable", "the relay cannot check tokens right now", { "retry-after": "5" })
    }
    // A token without a session stamp predates session binding: it could never be revoked, so it is not accepted.
    if (!claims || typeof claims.s !== "number") return fail(401, "token", "syrup_relay_token", "invalid ingest token")
    const tAuth = now()

    // 2. The route: a known provider and an allow-listed path, compared exactly. Object.hasOwn keeps __proto__ and friends out.
    const suffix = path.join("/")
    if (!Object.hasOwn(deps.baseURL, provider) || !Object.hasOwn(RELAY_ROUTES, suffix)) return fail(404, "bad_request", "syrup_relay_not_found", "not a relay route")
    const method = RELAY_ROUTES[suffix]
    if (req.method !== method) return fail(405, "bad_request", "syrup_relay_method", `${suffix} takes ${method}`, { allow: method })
    const { u: userId, w: workspaceId, s: sessionStart } = claims

    // 3. Keys and the session, while the body is read; on a cache hit this is already done. A read the request cannot
    // trust (the session or the expected key differs, or the provider just rejected this key) is redone from the database.
    const expect = req.headers.get(EXPECT_KEY_HEADER)?.trim() || null
    const rejectKey = `${userId}\n${provider}`
    const needsRead = (snap: RelaySnapshot) => {
      const sess = snap.sessions.get(workspaceId)
      if (!sess || !sess.live || sess.startedAt !== sessionStart) return true
      const k = snap.keys.get(provider)
      return !k || (expect !== null && k.id !== expect) || rejected.get(rejectKey) === k.id
    }
    const tKey0 = now()
    let tKey = tKey0
    const keyP = (async () => {
      let r = await deps.lookup(userId)
      if (needsRead(r.value)) {
        r = await deps.lookup(userId, { reload: true })
        if (!r.hit) rejected.delete(rejectKey)
      }
      return r
    })().then(
      (r) => {
        tKey = now()
        return { r, err: null as unknown }
      },
      (err: unknown) => ({ r: null, err: err ?? new Error("key lookup failed") }),
    )

    let body: Buffer | undefined
    let json: Record<string, unknown> | null = null
    if (method === "POST") {
      const type = req.headers.get("content-type") ?? ""
      if (!/^application\/json\b/i.test(type)) return fail(415, "bad_request", "syrup_relay_bad_request", "content-type must be application/json")
      const enc = (req.headers.get("content-encoding") ?? "").trim().toLowerCase()
      if (enc && enc !== "gzip" && enc !== "identity") return fail(415, "bad_request", "syrup_relay_bad_request", `content-encoding ${enc.slice(0, 20)} is not supported`)
      const raw = await readCapped(req, MAX_BODY_BYTES)
      if (!raw) return fail(400, "too_large", "syrup_relay_too_large", `request is over the ${MAX_BODY_BYTES / 1024 / 1024} MB limit of syrup's cloud relay`)
      if (enc === "gzip") {
        try {
          body = await gunzipAsync(raw, { maxOutputLength: MAX_INFLATED_BYTES })
        } catch {
          return fail(400, "bad_request", "syrup_relay_bad_request", `request body is not valid gzip, or inflates past ${MAX_INFLATED_BYTES / 1024 / 1024} MB`)
        }
      } else body = raw
      try {
        const j: unknown = JSON.parse(body.toString("utf8"))
        if (j && typeof j === "object" && !Array.isArray(j)) json = j as Record<string, unknown>
      } catch {}
      if (!json) return fail(400, "bad_request", "syrup_relay_bad_request", "request body is not a JSON object")
    }

    const { r: found, err } = await keyP
    if (err || !found) {
      log("relay.key_failed", { provider, workspaceId, message: causeOf(err) }, "error")
      return fail(503, "unavailable", "syrup_relay_unavailable", "could not read your key, try again shortly", { "retry-after": "2" })
    }
    const sess = found.value.sessions.get(workspaceId)
    if (!sess || !sess.live || sess.startedAt !== sessionStart) {
      log("relay.session_ended", { provider, workspaceId, live: sess?.live ?? null }, "warn")
      return fail(401, "token", "syrup_relay_token", "this sandbox session has ended")
    }
    const key = found.value.keys.get(provider)
    if (!key) return fail(401, "no_key", "syrup_no_key", `no active ${provider} key in syrup`)
    // Paid keys need the catalog on their first call; start loading it as soon as one is seen.
    if (key.tier === "paid") deps.catalog?.peek()

    // 4. The spend policy, on chat calls: the model must be one the router could pick for this key.
    let paid: Record<string, unknown> | null = null
    if (json) {
      let pol = checkPolicy(provider, key.tier, json, deps.catalog?.peek() ?? null)
      if (pol.ok === "catalog") {
        try {
          if (!deps.catalog) throw new Error("no model catalog configured")
          pol = checkPolicy(provider, key.tier, json, await deps.catalog.get())
        } catch (e) {
          log("relay.catalog_failed", { provider, message: causeOf(e) }, "error")
          return fail(503, "unavailable", "syrup_relay_unavailable", "could not load the model catalog, try again shortly", { "retry-after": "5" })
        }
      }
      if (pol.ok === "catalog") return fail(503, "unavailable", "syrup_relay_unavailable", "could not load the model catalog, try again shortly", { "retry-after": "5" })
      if (pol.ok === false) {
        log("relay.policy_refused", { userId, workspaceId, provider, tier: key.tier, keyId: key.id, model: typeof json.model === "string" ? json.model.slice(0, 120) : null, message: pol.message }, "warn")
        return fail(403, "policy", "syrup_relay_policy", pol.message)
      }
      if (pol.capped) body = Buffer.from(JSON.stringify(json), "utf8")
      if (key.tier === "paid") {
        paid = { userId, workspaceId, provider, keyId: key.id, model: pol.model, costs: pol.costs, maxTokens: pol.maxTokens, capped: pol.capped }
        log("relay.paid_call", paid)
      }
    }

    // 5. The provider call: fixed URL, real key, allow-listed headers, no redirects followed.
    const headers: Record<string, string> = { authorization: `Bearer ${key.secret}` }
    if (body) headers["content-type"] = "application/json"
    for (const h of PASS_ON) {
      const v = req.headers.get(h)
      if (v) headers[h] = v
    }
    const cut = new AbortController()
    let cutByDeadline = false
    const timer = setTimeout(
      () => {
        cutByDeadline = true
        cut.abort(new Error("relay deadline"))
      },
      Math.max(0, deps.deadlineMs - (now() - t0)),
    )
    timer.unref?.()
    const url = `${deps.baseURL[provider].replace(/\/$/, "")}/${suffix}`
    const tUp0 = now()
    const usage = paid ? new UsageSniffer() : null
    const spent = (status: number, ended: string) => {
      if (paid) log("relay.paid_usage", { ...paid, status, ended, promptTokens: usage?.prompt ?? null, completionTokens: usage?.completion ?? null })
    }
    let upstream: Response
    try {
      // Buffer.concat and gunzip return ArrayBuffer-backed buffers; the cast only satisfies BodyInit's typing.
      upstream = await doFetch(url, { method, headers, body: body as Uint8Array<ArrayBuffer> | undefined, signal: AbortSignal.any([req.signal, cut.signal]), redirect: "manual" })
    } catch (e) {
      clearTimeout(timer)
      spent(0, req.signal.aborted ? "cancelled" : cutByDeadline ? "deadline" : "unreachable")
      if (cutByDeadline) return fail(504, "deadline", "syrup_relay_deadline", "no answer from the provider before the relay's time limit")
      if (!req.signal.aborted) log("relay.upstream_failed", { provider, path: suffix, message: causeOf(e) }, "warn")
      return fail(502, "upstream", "syrup_relay_upstream", `upstream unreachable: ${causeOf(e)}`)
    }
    const tUp = now()
    // A provider rejecting a key served from the cache: it may have been replaced on another instance, so the next call
    // for this provider (and only this provider) reads the database first. A 400/403 counts only when it blames the key.
    if (found.hit && (upstream.status === 401 || upstream.status === 400 || upstream.status === 403)) {
      const reject = () => {
        rejected.delete(rejectKey)
        rejected.set(rejectKey, key.id)
        while (rejected.size > MAX_REJECTED) rejected.delete(rejected.keys().next().value as string)
      }
      if (upstream.status === 401) reject()
      else {
        const status = upstream.status
        void upstream
          .clone()
          .text()
          .then((text) => {
            if (classifyFailure({ status, headers: {}, body: text.slice(0, 4096), providerID: provider, promptTokens: 0, now: Date.now() }).reason === "auth") reject()
          })
          .catch(() => {})
      }
    }

    const out = new Headers()
    for (const h of PASS_BACK) {
      const v = upstream.headers.get(h)
      if (v) out.set(h, v)
    }
    out.set("cache-control", "no-cache, no-transform")
    out.set("x-accel-buffering", "no")
    out.set("x-syrup-key-id", key.id)
    out.set("server-timing", `auth;dur=${ms(tAuth - t0)}, key;dur=${ms(tKey - tKey0)};desc=${found.hit ? "hit" : "miss"}, upstream;dur=${ms(tUp - tUp0)}`)

    if (!upstream.body || NO_BODY.has(upstream.status)) {
      clearTimeout(timer)
      spent(upstream.status, "done")
      return new Response(null, { status: upstream.status, headers: out })
    }

    // 6. The answer, chunk by chunk as it arrives. Pull-based with no read-ahead, so a slow reader slows the provider
    // instead of piling up here; cancel (the sidecar went away) closes the provider connection.
    const reader = upstream.body.getReader()
    let done = false
    const finish = (ended: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      spent(upstream.status, ended)
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(ctrl) {
          try {
            const r = await reader.read()
            if (r.done) {
              finish("done")
              ctrl.close()
            } else {
              usage?.push(r.value)
              ctrl.enqueue(r.value)
            }
          } catch (e) {
            if (cutByDeadline) {
              finish("deadline")
              // Closed cleanly: the router records the answer as truncated (no health penalty) and the engine continues.
              log("relay.deadline_cut", { provider, path: suffix, workspaceId, afterMs: Math.round(now() - t0) }, "warn")
              ctrl.close()
            } else {
              finish("error")
              ctrl.error(e)
            }
          }
        },
        cancel(reason) {
          finish("cancelled")
          cut.abort(reason)
          return reader.cancel(reason).catch(() => {})
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(stream, { status: upstream.status, headers: out })
  }
}

/**
 * Per-instance cache of something loaded per user (the relay's keys and sandbox
 * sessions). Fresh for `freshMs`; after that it is served at once while one
 * background load refreshes it, for up to `maxAgeMs`. Past that a request waits
 * for a load. A failed refresh keeps the old value only for `failGraceMs`; then
 * requests wait for the database again and fail if it is still down, so a key
 * removed in Settings is not used for long while the database cannot say so.
 * Every load is bounded by `loadTimeoutMs`. Concurrent loads for one user are
 * shared, and at most `maxUsers` users are kept (least recently used first out).
 */
export type KeyCacheOptions = {
  freshMs?: number
  maxAgeMs?: number
  failGraceMs?: number
  loadTimeoutMs?: number
  /** reload() reads again only when the cached read is at least this old. */
  reloadGapMs?: number
  maxUsers?: number
  now?: () => number
  onError?: (userId: string, err: unknown) => void
  /** Hands each background refresh to the platform so it finishes after the response (Next's after()). */
  background?: (work: Promise<unknown>) => void
}

type Entry<V> = { value: V; at: number; failedAt: number | null }
type Load<V> = { p: Promise<V>; started: number; forgotten: boolean }

export class KeyCache<V> {
  private entries = new Map<string, Entry<V>>()
  private loads = new Map<string, Load<V>>()
  private freshMs: number
  private maxAgeMs: number
  private failGraceMs: number
  private loadTimeoutMs: number
  private reloadGapMs: number
  private maxUsers: number
  private now: () => number
  private onError: (userId: string, err: unknown) => void
  private background: (work: Promise<unknown>) => void

  constructor(
    private load: (userId: string) => Promise<V>,
    opts: KeyCacheOptions = {},
  ) {
    this.freshMs = opts.freshMs ?? 10_000
    this.maxAgeMs = opts.maxAgeMs ?? 60 * 60_000
    this.failGraceMs = opts.failGraceMs ?? 60_000
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 4_000
    this.reloadGapMs = opts.reloadGapMs ?? 1_000
    this.maxUsers = opts.maxUsers ?? 1_000
    this.now = opts.now ?? Date.now
    this.onError = opts.onError ?? (() => {})
    this.background = opts.background ?? (() => {})
  }

  get size(): number {
    return this.entries.size
  }

  async get(userId: string): Promise<{ value: V; hit: boolean; ageMs: number }> {
    const e = this.entries.get(userId)
    if (e) {
      const t = this.now()
      const age = t - e.at
      const failing = e.failedAt !== null && t - e.failedAt >= this.failGraceMs
      if (age < this.maxAgeMs && !failing) {
        this.entries.delete(userId)
        this.entries.set(userId, e)
        if (age >= this.freshMs) this.background(this.refresh(userId).catch((err: unknown) => this.onError(userId, err)))
        return { value: e.value, hit: true, ageMs: age }
      }
    }
    return { value: await this.refresh(userId), hit: false, ageMs: 0 }
  }

  /** Reads afresh, unless the cached read is under `reloadGapMs` old (then that read is returned as a hit). */
  async reload(userId: string): Promise<{ value: V; hit: boolean; ageMs: number }> {
    const e = this.entries.get(userId)
    if (e && this.now() - e.at < this.reloadGapMs && e.failedAt === null) return { value: e.value, hit: true, ageMs: this.now() - e.at }
    return { value: await this.refresh(userId), hit: false, ageMs: 0 }
  }

  /** Drops the user's entry and any load in flight (its result is handed to its waiters, not cached), so the next get reads afresh. */
  forget(userId: string): void {
    this.entries.delete(userId)
    const running = this.loads.get(userId)
    if (running) running.forgotten = true
    this.loads.delete(userId)
  }

  private refresh(userId: string): Promise<V> {
    const running = this.loads.get(userId)
    if (running) return running.p
    const rec: Load<V> = { p: undefined as unknown as Promise<V>, started: this.now(), forgotten: false }
    const loaded = this.load(userId).then((value) => {
      // A slow load that lost its waiters to the timeout is still kept, unless a forget() or a newer load came since.
      const cur = this.entries.get(userId)
      if (!rec.forgotten && (!cur || cur.at <= rec.started)) {
        this.entries.delete(userId)
        this.entries.set(userId, { value, at: this.now(), failedAt: null })
        while (this.entries.size > this.maxUsers) this.entries.delete(this.entries.keys().next().value as string)
      }
      return value
    })
    loaded.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    rec.p = Promise.race([
      loaded,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`key lookup took longer than ${this.loadTimeoutMs} ms`)), this.loadTimeoutMs)
        timer.unref?.()
      }),
    ])
      .catch((err: unknown) => {
        const cur = this.entries.get(userId)
        if (cur && cur.failedAt === null && !rec.forgotten) cur.failedAt = this.now()
        throw err
      })
      .finally(() => {
        clearTimeout(timer)
        if (this.loads.get(userId) === rec) this.loads.delete(userId)
      })
    this.loads.set(userId, rec)
    return rec.p
  }
}
