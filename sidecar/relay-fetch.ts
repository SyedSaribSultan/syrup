import { promisify } from "node:util"
import { constants, gzip } from "node:zlib"
import { RELAY_ERROR_HEADER, type RelayErrorKind } from "../src/server/router/upstream-errors"
import type { Log } from "../src/server/shared/log"

/**
 * The sidecar's fetch, wrapped for calls to the app's LLM relay
 * (/api/ingest/llm/<provider>/...); every other URL passes straight through.
 * The router core and served.ts call the global fetch, so wrapping it here
 * keeps them unchanged. Per relay call it:
 * - names the key id the router has on record (x-syrup-expect-key), so the
 *   relay never answers with a key the router did not book the call to;
 * - keeps the body under a Vercel Function's 4.5 MB request limit. A body over
 *   it because of images has its oldest images replaced by a short note (the
 *   latest message keeps its own); one that is too long in text answers as a
 *   context overflow, so OpenCode compacts the session. Neither teaches the
 *   router a prompt cap from an image-heavy request (images count as ~1,000
 *   tokens each in its estimate, whatever their size);
 * - optionally gzips large bodies (SYRUP_RELAY_GZIP);
 * - tries once more when the relay says the app could not read the key (a
 *   database blip), and marks anything the platform answered instead of the
 *   relay, so the router holds neither against a provider (upstream-errors.ts);
 * - logs relay.timing: time to response headers, split by the relay's
 *   server-timing into key lookup, provider and overhead (the added hop);
 * - asks for fresh key metadata when the relay used another key than the one on
 *   record (a key switched in Settings), without waiting for the minute poll.
 */

const gzipAsync = promisify(gzip)

/** Vercel's request body limit for Functions is 4.5 MB; stay under it in either unit. */
export const RELAY_MAX_BODY_BYTES = 4_400_000
const GZIP_MIN_BYTES = 64 * 1024
/** Least time between two key-metadata refreshes asked for by a key-id mismatch. */
const HINT_GAP_MS = 5_000
/** Wait before the one retry after the relay could not read the key. */
const RETRY_MS = 300
/** Least time between two relay.token_rejected log rows. */
const TOKEN_LOG_GAP_MS = 60_000
/** What replaces an image dropped to fit the relay's limit. */
export const IMAGE_DROPPED = "[An earlier image was removed here: the request was over the 4.4 MB limit of syrup's cloud relay.]"

export type RelayFetchOptions = {
  /** `${ingestUrl}/api/ingest/llm/`. Only URLs under it are touched. */
  prefix: string
  /** Read on every call, so tests can change them. */
  gzip?: boolean
  maxBodyBytes?: number
  log: Log
  /** The key id the router has on record for a provider. */
  keyId: (providerId: string) => string | undefined
  /** The relay used a different key: refresh the metadata. */
  onKeyMismatch: (providerId: string) => void
  now?: () => number
  /** Retry wait, for tests. */
  retryMs?: number
}

/** server-timing "a;dur=1.2, b;dur=3;desc=hit" → { a: { dur: 1.2 }, b: { dur: 3, desc: "hit" } }. */
export function parseServerTiming(v: string | null): Record<string, { dur?: number; desc?: string }> {
  const out: Record<string, { dur?: number; desc?: string }> = {}
  if (!v) return out
  for (const entry of v.split(",")) {
    const [name, ...params] = entry.split(";").map((s) => s.trim())
    if (!name) continue
    const m: { dur?: number; desc?: string } = {}
    for (const p of params) {
      const [k, raw = ""] = p.split("=")
      const val = raw.replace(/^"|"$/g, "")
      if (k === "dur" && Number.isFinite(Number(val))) m.dur = Number(val)
      if (k === "desc") m.desc = val
    }
    out[name] = m
  }
  return out
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1)

function localError(status: number, kind: RelayErrorKind, error: Record<string, string>): Response {
  return Response.json({ error }, { status, headers: { "x-syrup-relay": "local", [RELAY_ERROR_HEADER]: kind } })
}

/** The inline data URL of an image or file part, if it is one. */
function dataUrlOf(part: unknown): string | null {
  if (!part || typeof part !== "object") return null
  const p = part as { type?: unknown; image_url?: unknown; file?: { file_data?: unknown } }
  const url = p.type === "image_url" ? (typeof p.image_url === "string" ? p.image_url : (p.image_url as { url?: unknown } | undefined)?.url) : p.type === "file" ? p.file?.file_data : null
  return typeof url === "string" && url.startsWith("data:") ? url : null
}

export type Fit =
  /** Fits once `removed` earlier images were replaced by a note. */
  | { ok: true; text: string; removed: number }
  /** Too long in text alone (or not a chat body): a real overflow. */
  | { ok: false; why: "text" }
  /** Only the latest message's own images keep it over the limit. */
  | { ok: false; why: "latest"; latestBytes: number }

/**
 * Makes a chat body fit `cap` bytes by replacing inline images, oldest first,
 * with a short note. Images in the latest user message and after it (this
 * turn's) are never removed.
 */
export function fitBody(text: string, cap: number): Fit {
  let j: { messages?: unknown }
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, why: "text" }
  }
  const messages = Array.isArray(j?.messages) ? (j.messages as { role?: unknown; content?: unknown }[]) : null
  if (!messages) return { ok: false, why: "text" }
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m?.role === "user") lastUser = i
  })
  const parts: { msg: number; holder: unknown[]; idx: number; bytes: number }[] = []
  messages.forEach((m, i) => {
    if (!Array.isArray(m?.content)) return
    m.content.forEach((p, k) => {
      const url = dataUrlOf(p)
      if (url) parts.push({ msg: i, holder: m.content as unknown[], idx: k, bytes: url.length })
    })
  })
  const total = Buffer.byteLength(text, "utf8")
  const imageBytes = parts.reduce((n, p) => n + p.bytes, 0)
  if (total - imageBytes > cap) return { ok: false, why: "text" }
  const older = parts.filter((p) => p.msg < lastUser)
  const latestBytes = imageBytes - older.reduce((n, p) => n + p.bytes, 0)
  let est = total
  let removed = 0
  for (const p of older) {
    if (est <= cap) {
      const out = JSON.stringify(j)
      if (Buffer.byteLength(out, "utf8") <= cap) return { ok: true, text: out, removed }
    }
    p.holder[p.idx] = { type: "text", text: IMAGE_DROPPED }
    est -= p.bytes - IMAGE_DROPPED.length
    removed++
  }
  const out = JSON.stringify(j)
  if (Buffer.byteLength(out, "utf8") <= cap) return { ok: true, text: out, removed }
  return { ok: false, why: "latest", latestBytes }
}

export function relayFetch(inner: typeof fetch, opts: RelayFetchOptions): typeof fetch {
  const now = opts.now ?? (() => performance.now())
  let lastHint = -Infinity
  let lastTokenLog = -Infinity
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(opts.prefix)) return inner(input, init)
    const rest = url.slice(opts.prefix.length)
    const slash = rest.indexOf("/")
    const provider = slash < 0 ? rest : rest.slice(0, slash)
    const path = slash < 0 ? "" : rest.slice(slash + 1)
    const cap = opts.maxBodyBytes ?? RELAY_MAX_BODY_BYTES

    const headers = new Headers(init?.headers)
    const known = opts.keyId(provider)
    if (known) headers.set("x-syrup-expect-key", known)
    let body = init?.body
    if (typeof body === "string" || body instanceof Uint8Array) {
      let bytes: Uint8Array = typeof body === "string" ? Buffer.from(body, "utf8") : body
      const squeeze = async (b: Uint8Array) => (opts.gzip && b.byteLength >= GZIP_MIN_BYTES ? { b: await gzipAsync(b, { level: constants.Z_BEST_SPEED }), gz: true } : { b, gz: false })
      let sent = await squeeze(bytes)
      if (sent.b.byteLength > cap) {
        const fit = path === "chat/completions" ? fitBody(Buffer.from(bytes).toString("utf8"), cap) : ({ ok: false, why: "text" } as const)
        if (!fit.ok) {
          opts.log("router", "relay.too_large", { provider, path, bytes: bytes.byteLength, why: fit.why }, { level: "warn" })
          if (fit.why === "latest") {
            return localError(400, "too_large", {
              type: "syrup_relay_too_large",
              message: `the images in the latest message total ${mb(fit.latestBytes)} MB; syrup's cloud relay takes at most ${mb(cap)} MB per request. Send fewer or smaller images.`,
            })
          }
          // Wording and code OpenCode treats as a context overflow: it compacts the session and tries again.
          return localError(400, "overflow", {
            type: "syrup_relay_too_large",
            code: "context_length_exceeded",
            message: `request is ${mb(bytes.byteLength)} MB, over the ${mb(cap)} MB limit of syrup's cloud relay: maximum context length exceeded`,
          })
        }
        opts.log("router", "relay.images_dropped", { provider, removed: fit.removed, bytesBefore: bytes.byteLength, bytesAfter: Buffer.byteLength(fit.text, "utf8") }, { level: "warn" })
        bytes = Buffer.from(fit.text, "utf8")
        sent = await squeeze(bytes)
      }
      if (sent.gz) headers.set("content-encoding", "gzip")
      // Buffer.from and gzip return ArrayBuffer-backed buffers; the cast only satisfies BodyInit's typing.
      body = sent.b as Uint8Array<ArrayBuffer>
    }

    const t0 = now()
    // The router and served.ts pass a URL string and an init; a Request object's own body or headers are not carried over.
    const send = () => inner(url, { ...init, headers, body })
    let res = await send()
    if (res.status === 503 && res.headers.get(RELAY_ERROR_HEADER) === "unavailable" && !init?.signal?.aborted) {
      await res.body?.cancel().catch(() => {})
      await new Promise((r) => setTimeout(r, opts.retryMs ?? RETRY_MS))
      if (!init?.signal?.aborted) res = await send()
    }
    // Not the relay and not the provider: the platform answered (a crash, a limit, the app's own timeout).
    if (res.status >= 400 && !res.headers.has(RELAY_ERROR_HEADER) && !res.headers.has("x-syrup-key-id")) {
      const h = new Headers(res.headers)
      h.set(RELAY_ERROR_HEADER, res.status === 413 ? "too_large" : "platform")
      res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
    }
    const total = now() - t0
    const st = parseServerTiming(res.headers.get("server-timing"))
    const upstream = st.upstream?.dur
    opts.log("router", "relay.timing", {
      provider,
      path,
      status: res.status,
      relayError: res.headers.get(RELAY_ERROR_HEADER) ?? undefined,
      totalToHeadersMs: Math.round(total),
      keyMs: st.key?.dur !== undefined ? Math.round(st.key.dur) : null,
      upstreamMs: upstream !== undefined ? Math.round(upstream) : null,
      overheadMs: upstream !== undefined ? Math.round(total - upstream) : null,
      cacheHit: st.key?.desc ? st.key.desc === "hit" : null,
    })
    if (res.headers.get(RELAY_ERROR_HEADER) === "token" && now() - lastTokenLog >= TOKEN_LOG_GAP_MS) {
      lastTokenLog = now()
      // Every provider would look revoked; this is one cause, the sandbox's own token (expired, or its session ended).
      opts.log("router", "relay.token_rejected", { provider, status: res.status }, { level: "error" })
    }

    const used = res.headers.get("x-syrup-key-id")
    if (used && known && used !== known && now() - lastHint >= HINT_GAP_MS) {
      lastHint = now()
      opts.onKeyMismatch(provider)
    }
    return res
  }
  return wrapped as typeof fetch
}
