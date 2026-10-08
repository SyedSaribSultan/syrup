/**
 * Links in an answer must point at pages the agent actually saw: a URL in a websearch result,
 * a webfetch input or output, any other tool's text, or the user's own messages.
 * Compared normalised: scheme, "www.", trailing slash, fragment and tracking parameters ignored.
 */
import { mdLines } from "./markdown"
import type { Finding, Source } from "./types"

const TRACKING = /^(?:utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si)$/i
const IGNORED_HOSTS = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|example\.(?:com|org|net))(?::\d+)?$/i

/** "https://www.Example.com/a/?utm_source=x#top" → "example.com/a". Returns null for anything that isn't http(s). */
export function normalizeUrl(raw: string): string | null {
  const u = raw.trim().replace(/[)\].,;:!?'"*_>]+$/, "")
  const m = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i.exec(u)
  if (!m) return null
  const host = m[2].toLowerCase().replace(/^www\./, "").replace(/:(?:80|443)$/, "")
  let path = m[3] || ""
  try {
    path = decodeURI(path)
  } catch {
    // keep as written
  }
  path = path.replace(/\/+$/, "")
  const query = (m[4] ?? "")
    .slice(1)
    .split("&")
    .filter((kv) => kv && !TRACKING.test(kv.split("=")[0]))
    .sort()
    .join("&")
  return `${host}${path}${query ? `?${query}` : ""}`
}

const hostOf = (normalized: string) => normalized.split(/[/?]/)[0]

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`\])}]+(?:\([^\s)]*\))?[^\s<>"'`\])}.,;:!?*]*/gi

/** Every http(s) URL in a piece of text. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)].map((m) => m[0])
}

export type CitedLink = { url: string; line: number; excerpt: string }

/** Links an answer cites: Markdown links, <autolinks> and bare URLs, outside code blocks and inline code. */
export function citedLinks(md: string): CitedLink[] {
  const out: CitedLink[] = []
  for (const l of mdLines(md)) {
    if (l.code) continue
    const text = l.text.replace(/`[^`]*`/g, " ")
    const seen = new Set<string>()
    for (const m of text.matchAll(/\]\((https?:\/\/[^)\s]+(?:\([^)\s]*\))?[^)\s]*)(?:\s+"[^"]*")?\)/gi)) seen.add(m[1])
    for (const u of urlsIn(text.replace(/\]\((https?:\/\/[^)\s]+)\)/gi, "]"))) seen.add(u)
    for (const url of seen) out.push({ url, line: l.index, excerpt: l.text.trim() })
  }
  return out
}

/** The normalised URLs, and their hosts, that a set of sources shows. */
export function seenUrls(sources: Source[]): { pages: Set<string>; hosts: Set<string> } {
  const pages = new Set<string>()
  const hosts = new Set<string>()
  const add = (raw: string) => {
    const n = normalizeUrl(raw)
    if (!n) return
    pages.add(n)
    hosts.add(hostOf(n))
  }
  for (const s of sources) {
    if (s.url) add(s.url)
    for (const u of urlsIn(s.text)) add(u)
  }
  return { pages, hosts }
}

export function checkCitedUrls(md: string, sources: Source[]): Finding[] {
  const { pages, hosts } = seenUrls(sources)
  const out: Finding[] = []
  const reported = new Set<string>()
  for (const link of citedLinks(md)) {
    const n = normalizeUrl(link.url)
    if (!n || reported.has(n) || IGNORED_HOSTS.test(hostOf(n))) continue
    reported.add(n)
    if (pages.has(n)) continue
    const hostSeen = hosts.has(hostOf(n))
    out.push({
      check: "cited-url",
      severity: hostSeen ? "hint" : "warn",
      message: hostSeen ? `${link.url} is on a site the agent read, but not a page it opened.` : `${link.url} is not from any page the agent read in this chat.`,
      evidence: { excerpt: link.excerpt, line: link.line + 1, url: link.url, normalized: n },
    })
  }
  return out
}
