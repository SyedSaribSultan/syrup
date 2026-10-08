import createDOMPurify, { type Config, type DOMPurify } from "dompurify"

/**
 * Agent markup on syrup's origin (docs/RENDERING.md §2.12). Our own DOMPurify instance (never the copy Mermaid uses),
 * with URL and CSS hooks on top of the SVG profile:
 *   - href, xlink:href and src only as "#…" (an <image> may also hold a PNG, JPEG, GIF or WebP data: URL); any other
 *     attribute value with url(…) only as url(#…); animation attributeName never names href or an on* handler.
 *   - CSS, in every <style> and every style attribute: url(…) only as url(#…); no image-set(), @import or @font-face;
 *     no quoted string holding ":" or "//"; no position: fixed or sticky; in <style>, no rule whose selector reaches
 *     :host. A refused style attribute is dropped, a refused <style> emptied.
 * The result still goes into a shadow root inside a light-DOM clip (.rich-clip), which confines whatever escapes this.
 * Loaded by the renderers that need it (svg, mermaid), not by the core.
 */

export const MAX_SVG_BYTES = 200 * 1024

const FORBID_TAGS = ["foreignObject", "script", "animate", "set", "animateMotion", "animateTransform"]
const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp)[;,]/i
const LINK_ATTRS = new Set(["href", "xlink:href", "src"])

/** CSS text (already normalized by the browser's parser) that may fetch or escape: refused whole. */
export function refusedCss(css: string): boolean {
  if (/@import|@font-face|image-set\s*\(|@namespace|\bsrc\s*\(/i.test(css)) return true
  for (const m of css.matchAll(/url\s*\(\s*(['"]?)([^'")]*)/gi)) if (!m[2].trim().startsWith("#")) return true
  for (const m of css.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
    const s = m[1] ?? m[2] ?? ""
    if (s.includes(":") || s.includes("//")) return true
  }
  // An escape the parser kept could spell any of the above.
  return /\\/.test(css)
}

const POSITION_BANNED = /^(fixed|sticky|-webkit-sticky)$/i

/** The rules of a style sheet, edited in place: :host rules dropped, fixed and sticky positions removed. */
function scrubRules(list: CSSRuleList, owner: { deleteRule(i: number): void }): boolean {
  for (let i = list.length - 1; i >= 0; i--) {
    const rule = list[i]
    const type = rule.constructor.name
    if (type === "CSSImportRule" || type === "CSSFontFaceRule" || type === "CSSNamespaceRule") return false
    if (rule instanceof CSSStyleRule) {
      if (/:host|::slotted|::part/i.test(rule.selectorText)) {
        owner.deleteRule(i)
        continue
      }
      if (POSITION_BANNED.test(rule.style.getPropertyValue("position").trim())) rule.style.removeProperty("position")
    }
    const inner = (rule as CSSRule & { cssRules?: CSSRuleList; deleteRule?(i: number): void }).cssRules
    if (inner && "deleteRule" in rule && !scrubRules(inner, rule as unknown as { deleteRule(i: number): void })) return false
  }
  return true
}

/** A <style> element's text, cleaned; "" when it is refused. */
export function cleanStyleSheet(text: string): string {
  if (!text.trim() || text.length > MAX_SVG_BYTES) return ""
  if (/@import|@font-face|image-set\s*\(/i.test(text)) return ""
  let sheet: CSSStyleSheet
  try {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(text)
  } catch {
    return ""
  }
  if (!scrubRules(sheet.cssRules, sheet)) return ""
  const out = Array.from(sheet.cssRules, (r) => r.cssText).join("\n")
  return refusedCss(out) ? "" : out
}

let scratch: HTMLElement | null = null

/** A style attribute's value, cleaned; null when it is refused. */
export function cleanStyleAttr(value: string): string | null {
  scratch ??= document.createElement("div")
  scratch.style.cssText = value
  if (POSITION_BANNED.test(scratch.style.getPropertyValue("position").trim())) scratch.style.removeProperty("position")
  const out = scratch.style.cssText
  scratch.removeAttribute("style")
  if (refusedCss(out)) return null
  return out
}

let purify: DOMPurify | null = null

function instance(): DOMPurify {
  if (purify) return purify
  const p = createDOMPurify(window)
  p.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") node.textContent = cleanStyleSheet(node.textContent ?? "")
  })
  p.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName.toLowerCase()
    const value = data.attrValue ?? ""
    const tag = node.nodeName.toLowerCase()
    if (LINK_ATTRS.has(name)) {
      const v = value.trim()
      const ok = v.startsWith("#") || ((tag === "image" || tag === "feimage" || tag === "img") && IMAGE_DATA.test(v))
      if (!ok) data.keepAttr = false
      return
    }
    if (name === "attributename" && /^(xlink:)?href$|^on|^style$/i.test(value.trim())) {
      data.keepAttr = false
      return
    }
    if (name === "style") {
      const clean = cleanStyleAttr(value)
      if (clean === null) data.keepAttr = false
      else data.attrValue = clean
      return
    }
    // A presentation attribute (fill, stroke, mask, clip-path, marker-*, filter…) is CSS to the browser: a CSS escape
    // can spell url( ("\75rl(https://…)"), so no attribute value may hold a backslash at all.
    if (value.includes("\\")) data.keepAttr = false
    else if (/url\s*\(/i.test(value) && refusedCss(value.replace(/url\s*\(\s*['"]?#[^)]*\)/gi, ""))) data.keepAttr = false
    else if (/(image-set|\bsrc)\s*\(/i.test(value)) data.keepAttr = false
  })
  purify = p
  return p
}

export type CleanSvg = { markup: string; width: number; height: number; svg: SVGSVGElement } | null

const num = (v: string | null): number | null => {
  if (!v) return null
  const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v)
  return m ? Number(m[1]) : null
}

/**
 * Sanitizes markup to one <svg>: an agent's, or Mermaid's output (whose size limit is the caller's: `max`). Null when
 * nothing safe is left.
 */
export function sanitizeSvg(input: string, { max = MAX_SVG_BYTES }: { max?: number } = {}): CleanSvg {
  if (input.length > max) return null
  const cfg: Config = { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS, RETURN_DOM_FRAGMENT: true }
  const frag = instance().sanitize(input, cfg) as unknown as DocumentFragment
  const svg = Array.from(frag.children).find((el) => el.localName === "svg") as SVGSVGElement | undefined
  if (!svg || !Array.from(svg.children).some((c) => c.localName !== "style" && c.localName !== "title" && c.localName !== "desc")) return null
  const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number)
  const width = num(svg.getAttribute("width")) ?? (vb.length === 4 && vb[2] > 0 ? vb[2] : 300)
  const height = num(svg.getAttribute("height")) ?? (vb.length === 4 && vb[3] > 0 ? vb[3] : 150)
  svg.setAttribute("aria-hidden", "true")
  svg.removeAttribute("role")
  const markup = new XMLSerializer().serializeToString(svg)
  return { markup, width, height, svg }
}
