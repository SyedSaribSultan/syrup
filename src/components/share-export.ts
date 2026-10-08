"use client"

import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ensure, loadCore, loadKatex, loadMath } from "@/lib/rich/lazy"
import { clipForViewer, type Transcript } from "@/lib/transcript"
import type { ExportItems } from "./rich/types"
import { ShareDocument } from "./share-view"

/**
 * A shared chat as one self-contained HTML file: the same read-only rendering
 * as the public viewer, the app's stylesheet inlined and its fonts embedded as
 * data: URLs. Tool steps and thinking are native <details>, so the file works
 * without JavaScript. Built in the browser from the sanitized transcript.
 *
 * Pictures (docs/RENDERING.md §2.9): a first pass collects every diagram and picture the reader would see, they are
 * prerendered in the light theme, and a second pass embeds them as declarative shadow roots on a paper card (an agent
 * SVG as an <img>), each with its source under it. Math is MathML, which needs no fonts. The file holds no <script>.
 */

const MAX_FONT_BYTES = 2 * 1024 * 1024

const FONT_MIME: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" }

function toBase64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/** Renderer stylesheets stay out of the file: KaTeX's (MathML needs none), and later Excalidraw's and MapLibre's. */
const RENDERER_SHEET = /KaTeX_|\.excalidraw|\.maplibregl-/

/** Every same-origin stylesheet on the page, with font URLs replaced by data: URLs. */
async function inlineCss(): Promise<string> {
  let fontBytes = 0
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let css: string
    try {
      css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n")
    } catch {
      continue
    }
    if (RENDERER_SHEET.test(css)) continue
    const base = sheet.href ?? location.href
    const refs = [...new Set([...css.matchAll(/url\((['"]?)([^'")]+\.(woff2?|ttf|otf))\1\)/g)].map((m) => m[2]))]
    for (const ref of refs) {
      if (fontBytes > MAX_FONT_BYTES) break
      try {
        const res = await fetch(new URL(ref, base))
        if (!res.ok) continue
        const bytes = new Uint8Array(await res.arrayBuffer())
        fontBytes += bytes.length
        const ext = ref.split(".").pop()!.toLowerCase()
        css = css.split(ref).join(`data:${FONT_MIME[ext] ?? "font/woff2"};base64,${toBase64(bytes)}`)
      } catch {}
    }
    out.push(css)
  }
  return out.join("\n")
}

export async function transcriptToHtml(t: Transcript): Promise<string> {
  const transcript = clipForViewer(t)
  // Offline (or a deploy renamed the chunks): the file still comes out, with code blocks and TeX instead of pictures.
  const [core] = await Promise.all([ensure(loadCore), ensure(loadMath).catch(() => null), ensure(loadKatex).catch(() => null)]).catch(() => [null])
  const host = document.createElement("div")
  let root = createRoot(host)
  if (core) {
    // 1. Collect what the reader would see drawn.
    const items: ExportItems = { blocks: [], tex: [] }
    flushSync(() => root.render(createElement(core.RichCollect, { into: items }, createElement(ShareDocument, { transcript }))))
    root.unmount()
    // 2. Prerender it in the light theme. 3. Embed it.
    const statics = await core.prerenderForExport(items, { timeoutMs: 20_000 })
    root = createRoot(host)
    flushSync(() => root.render(createElement(core.RichExport, { statics }, createElement(ShareDocument, { transcript }))))
  } else flushSync(() => root.render(createElement(ShareDocument, { transcript })))
  const body = host.innerHTML
  root.unmount()
  const css = await inlineCss()
  const htmlClass = document.documentElement.className
  return [
    "<!doctype html>",
    `<html lang="en" class="${escapeHtml(htmlClass)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(t.title)} · syrup</title>`,
    `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`,
    "</head>",
    `<body class="h-full">${body}</body>`,
    "</html>",
  ].join("\n")
}

/** Saves text as a file through a temporary link. */
export function saveFile(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
