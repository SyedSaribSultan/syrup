/**
 * The browser side of export-dom.ts: bundled by esbuild into one script, run in Playwright's Chromium. It exposes
 * what only a real DOM can answer: how the export's declarative shadow root serializes, what the sanitizer keeps,
 * and whether Mermaid itself accepts a diagram.
 */
import mermaid from "mermaid"
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { cleanStyleAttr, cleanStyleSheet, sanitizeSvg } from "@/components/rich/sanitize"
import mermaidRenderer from "@/components/rich/renderers/mermaid"
import { ExportPicture } from "@/components/rich/shadow-markup"
import { LIGHT_TOKENS } from "@/components/rich/theme-tokens"
import { mermaidFixes } from "@/lib/rich/autofix"

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", logLevel: "fatal", suppressErrorRendering: true })

;(window as unknown as { __rich: unknown }).__rich = {
  exportHtml(markup: string): string {
    const host = document.createElement("div")
    const root = createRoot(host)
    flushSync(() => root.render(createElement(ExportPicture, { render: { markup, width: 10, height: 10, label: "probe" } })))
    const html = host.innerHTML
    root.unmount()
    return html
  },
  sanitize(input: string): string | null {
    return sanitizeSvg(input)?.markup ?? null
  },
  styleSheet: cleanStyleSheet,
  styleAttr: cleanStyleAttr,
  async parse(source: string): Promise<boolean> {
    try {
      await mermaid.parse(source)
      return true
    } catch {
      return false
    }
  },
  fixes: mermaidFixes,
  /** The chat's own Mermaid renderer, end to end (validate, render, the outer sanitizer pass): its markup or "invalid". */
  async mermaidSvg(source: string): Promise<string> {
    const signal = new AbortController().signal
    const input = { kind: "mermaid" as const, lang: "mermaid", source, origin: { from: "block" as const } }
    const v = await mermaidRenderer.validate(input, signal)
    if (!v.ok) return v.error.code === "remote" ? "remote" : "invalid"
    const r = await mermaidRenderer.toStatic!(v.value, { surface: "chat", tokens: LIGHT_TOKENS, width: 0, signal })
    return r.markup
  },
}
