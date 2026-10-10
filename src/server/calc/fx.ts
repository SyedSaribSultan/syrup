/**
 * Today's exchange rates for syrup_calc: fawazahmed0's currency-api (CC0, no key, no rate limit, daily), the USD table,
 * from jsDelivr with the project's documented Cloudflare fallback. Kept in memory for 12 hours. A failed fetch is
 * remembered for a minute so a burst of calls doesn't wait on a dead network each time; a table up to 3 days old is
 * used (with its date) when a refresh fails. With nothing usable, the caller gets null and the tool says so: a rate is
 * never guessed. Runs in the local server and in the sandbox sidecar; both hosts are on the strict egress list
 * (src/server/engine/egress.ts, FX_HOSTS).
 */
import type { RateTable } from "./core"

/**
 * The project's own host first (it serves nothing else), jsDelivr second. Both are on the strict egress list: the
 * project asks clients to keep the fallback, and jsDelivr adds no reach a sandbox lacks (npm and GitHub hosts are
 * already allowed).
 */
export const FX_SOURCES = [
  "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
]
export const FX_HOSTS = FX_SOURCES.map((u) => new URL(u).hostname)
const SOURCE_NAME = "currency-api by fawazahmed0, CC0"

const FRESH_MS = 12 * 3600_000
const STALE_OK_MS = 3 * 24 * 3600_000
const RETRY_AFTER_MS = 60_000
const TIMEOUT_MS = 3_000
const MAX_BYTES = 256 * 1024

type FetchResponse = {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null
  text(): Promise<string>
}
type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<FetchResponse>

/** The body as text, never more than MAX_BYTES of it: a declared length over the cap is refused unread, and a stream is cut. */
export async function readCapped(res: FetchResponse): Promise<string | null> {
  const declared = Number(res.headers?.get("content-length") ?? NaN)
  if (declared > MAX_BYTES) return null
  if (!res.body) {
    const t = await res.text()
    return t.length > MAX_BYTES ? null : t
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return new TextDecoder().decode(all)
}

let cache: { table: RateTable; at: number } | null = null
let failedAt = -Infinity
let inflight: Promise<RateTable | null> | null = null

/** Parses the API's `{ date, usd: { pkr: 277.1, … } }`; null when it isn't that shape. */
export function parseTable(body: string): RateTable | null {
  if (body.length > MAX_BYTES) return null
  let j: unknown
  try {
    j = JSON.parse(body)
  } catch {
    return null
  }
  if (!j || typeof j !== "object") return null
  const { date, usd } = j as { date?: unknown; usd?: unknown }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !usd || typeof usd !== "object") return null
  const out: Record<string, number> = Object.create(null)
  for (const [k, v] of Object.entries(usd as Record<string, unknown>)) {
    if (/^[a-z]{3}$/.test(k) && typeof v === "number" && Number.isFinite(v) && v > 0) out[k.toUpperCase()] = v
  }
  // A table without the major currencies, or with EUR and GBP far from where they have ever been, is a broken
  // answer (or a tampered one), not a rate source.
  if (!out.EUR || !out.GBP || !out.INR || !out.PKR) return null
  if (out.EUR < 0.4 || out.EUR > 2.5 || out.GBP < 0.3 || out.GBP > 2) return null
  // The rupees the tool is mostly asked about: within 3x of the checks' reference rates (277 PKR, 88 INR per USD,
  // October 2026). A table that says 2.8 billion is not believed; a real move that big would need this band moved.
  if (out.PKR < 277 / 3 || out.PKR > 277 * 3 || out.INR < 88 / 3 || out.INR > 88 * 3) return null
  return { usd: out, date, source: SOURCE_NAME }
}

async function fetchTable(fetchImpl: Fetch): Promise<RateTable | null> {
  for (const url of FX_SOURCES) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) continue
      const body = await readCapped(res)
      const t = body === null ? null : parseTable(body)
      if (t) return t
    } catch {
      // Next source.
    }
  }
  return null
}

/** The USD rate table: cached, fetched when older than 12 hours, null when nothing usable can be had. */
export async function usdTable(opts: { fetch?: Fetch; now?: () => number } = {}): Promise<RateTable | null> {
  const now = (opts.now ?? Date.now)()
  if (cache && now - cache.at < FRESH_MS) return cache.table
  const stale = cache && now - cache.at < STALE_OK_MS ? cache.table : null
  if (now - failedAt < RETRY_AFTER_MS) return stale
  inflight ??= fetchTable(opts.fetch ?? (fetch as unknown as Fetch)).finally(() => {
    inflight = null
  })
  const t = await inflight
  if (t) {
    cache = { table: t, at: now }
    return t
  }
  failedAt = now
  return stale
}

/** Tests only: forget the cache. */
export function resetFxCache(): void {
  cache = null
  failedAt = -Infinity
  inflight = null
}
