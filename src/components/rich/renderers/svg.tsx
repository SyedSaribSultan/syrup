import { MAX_SVG_BYTES, sanitizeSvg } from "../sanitize"
import type { Renderer } from "../types"

/**
 * ```svg fences and .svg files (docs/RENDERING.md §3.2a): sanitized (§2.12), then drawn in a shadow root inside the
 * clip; in dark mode on a light paper card, so black-on-transparent drawings stay visible. Read-only views get an
 * <img> of the same markup (the core decides).
 */

type Value = { markup: string; width: number; height: number; label: string }

const renderer: Renderer<Value> = {
  kind: "svg",
  version: "svg/dompurify@3.4.16/r1",
  paper: true,
  async validate(input) {
    if (input.source.length > MAX_SVG_BYTES) return { ok: false, error: { code: "too-large", message: "Too large to draw here.", repairable: false } }
    const clean = sanitizeSvg(input.source)
    if (!clean) return { ok: false, error: { code: "empty", message: "This SVG had nothing safe to show.", repairable: false } }
    const named = clean.svg.getAttribute("aria-label") || clean.svg.querySelector("title")?.textContent?.trim()
    return { ok: true, value: { markup: clean.markup, width: clean.width, height: clean.height, label: named ? `Picture: ${named}` : "Picture" }, warnings: [] }
  },
  async toStatic(v) {
    return { markup: v.markup, width: v.width, height: v.height, label: v.label }
  },
}

export default renderer
