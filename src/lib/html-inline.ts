"use client"

import type { FileBody } from "./file-actions"
import { cleanRel, extOf, parentRel } from "./fs-rules"

/**
 * Makes a workspace HTML page self-contained for a sandboxed srcdoc iframe:
 * local stylesheets and scripts are inlined, images, fonts and media become
 * data: URLs (an opaque-origin frame can't load syrup's blob: URLs). Links to
 * other local pages are reported to the parent through postMessage.
 */

type ReadAsset = (rel: string) => Promise<FileBody | null>

const MAX_ASSETS = 120
const MAX_BYTES = 20 * 1024 * 1024

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
  css: "text/css", js: "text/javascript", json: "application/json",
}

/** Where a relative URL in a file at `fromDir` points, workspace-relative. Null for external, data:, and in-page URLs. */
export function resolveAsset(url: string, fromDir: string): string | null {
  const u = url.trim()
  if (!u || u.startsWith("#") || u.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(u)) return null
  let p: string
  try {
    p = decodeURIComponent(new URL(u, `http://x/${fromDir ? `${fromDir}/` : ""}`).pathname)
  } catch {
    return null
  }
  return cleanRel(p.replace(/^\/+/, ""))
}

// The bridge for clicks on local links; the parent checks the message came from this frame.
const NAV = `<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(!h||h.charAt(0)==="#"||/^[a-z][a-z0-9+.-]*:/i.test(h)||h.slice(0,2)==="//")return;e.preventDefault();parent.postMessage({syrupPreviewNav:h},"*")},true)</script>`

function toBase64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export async function inlineHtml(html: string, htmlRel: string, readAsset: ReadAsset): Promise<{ html: string; missing: string[] }> {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const dir = parentRel(htmlRel)
  const cache = new Map<string, Promise<FileBody | null>>()
  const missing: string[] = []
  let used = 0
  let count = 0

  // Root-absolute URLs ("/static/app.css") try the page's folder first, then the workspace root.
  function candidates(url: string, from: string): string[] {
    const a = resolveAsset(url, from)
    if (!a) return []
    return url.trim().startsWith("/") && from ? [...new Set([`${from}/${a}`, a])] : [a]
  }

  async function fetchAsset(url: string, from: string): Promise<{ rel: string; body: FileBody } | null> {
    for (const rel of candidates(url, from)) {
      if (!cache.has(rel)) {
        if (++count > MAX_ASSETS || used > MAX_BYTES) return null
        cache.set(rel, readAsset(rel).catch(() => null))
      }
      const body = await cache.get(rel)!
      if (body) {
        used += body.kind === "text" ? body.text.length : body.bytes.length
        return { rel, body }
      }
    }
    if (candidates(url, from).length) missing.push(url)
    return null
  }

  async function dataUrl(url: string, from: string): Promise<string | null> {
    const a = await fetchAsset(url, from)
    if (!a || used > MAX_BYTES) return null
    const mime = MIME[extOf(a.rel)] ?? (a.body.kind === "binary" ? a.body.mime : "text/plain") ?? "application/octet-stream"
    const bytes = a.body.kind === "text" ? new TextEncoder().encode(a.body.text) : a.body.bytes
    return `data:${mime};base64,${toBase64(bytes)}`
  }

  async function rewriteCss(css: string, from: string): Promise<string> {
    const refs = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
    let out = css
    for (const m of refs) {
      const d = await dataUrl(m[2], from)
      if (d) out = out.split(m[0]).join(`url("${d}")`)
    }
    return out
  }

  for (const link of [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')]) {
    const a = await fetchAsset(link.getAttribute("href")!, dir)
    if (!a || a.body.kind !== "text") continue
    const style = doc.createElement("style")
    style.textContent = await rewriteCss(a.body.text, parentRel(a.rel))
    link.replaceWith(style)
  }
  for (const s of [...doc.querySelectorAll<HTMLStyleElement>("style")]) {
    if (s.textContent?.includes("url(")) s.textContent = await rewriteCss(s.textContent, dir)
  }
  for (const script of [...doc.querySelectorAll<HTMLScriptElement>("script[src]")]) {
    const a = await fetchAsset(script.getAttribute("src")!, dir)
    if (!a || a.body.kind !== "text") continue
    script.removeAttribute("src")
    // The serializer does not escape script text; a literal "</script" would end the element early.
    script.textContent = a.body.text.replace(/<\/script/gi, "<\\/script")
  }
  for (const el of [...doc.querySelectorAll<HTMLElement>("img[src], source[src], video[src], audio[src], input[type=image][src], track[src], video[poster], link[rel~=icon][href]")]) {
    for (const attr of ["src", "poster", "href"]) {
      const v = el.getAttribute(attr)
      if (!v || (attr === "href" && el.tagName !== "LINK")) continue
      const d = await dataUrl(v, dir)
      if (d) el.setAttribute(attr, d)
    }
    if (el.hasAttribute("srcset")) el.removeAttribute("srcset")
  }
  for (const el of [...doc.querySelectorAll<HTMLElement>("[style*='url(']")]) {
    el.setAttribute("style", await rewriteCss(el.getAttribute("style")!, dir))
  }

  doc.head.insertAdjacentHTML("afterbegin", NAV)
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, missing: [...new Set(missing)] }
}
