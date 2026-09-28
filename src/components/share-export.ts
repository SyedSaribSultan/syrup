"use client"

import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { clipForViewer, type Transcript } from "@/lib/transcript"
import { ShareDocument } from "./share-view"

/**
 * A shared chat as one self-contained HTML file: the same read-only rendering
 * as the public viewer, the app's stylesheet inlined and its fonts embedded as
 * data: URLs. Tool steps and thinking are native <details>, so the file works
 * without JavaScript. Built in the browser from the sanitized transcript.
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
  const host = document.createElement("div")
  const root = createRoot(host)
  flushSync(() => root.render(createElement(ShareDocument, { transcript: clipForViewer(t) })))
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
