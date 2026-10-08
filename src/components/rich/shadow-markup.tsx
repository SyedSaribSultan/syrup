"use client"

import { useLayoutEffect, useRef, type CSSProperties } from "react"
import type { StaticRender } from "./types"

/**
 * Where sanitized picture markup meets the page (docs/RENDERING.md §2.6, §2.9, §2.12). One of the two places under
 * src/components/rich/ allowed to set HTML (the math renderer is the other; test:rich greps for the rest):
 *   - Picture: a live open shadow root (selectors in the picture never reach the app, nor the app's into it), inside
 *     the light-DOM clip that confines what escapes the box.
 *   - ImgPicture: read-only views draw an agent SVG as an <img> of a data: URL, which can't run, fetch or overlay.
 *   - ExportPicture: the HTML export's declarative shadow root, a <template shadowrootmode> filled through
 *     dangerouslySetInnerHTML (React would put children into the element, where they serialize as nothing).
 */

const BASE_CSS = ":host{display:block}svg{display:block;max-width:100%;height:auto;margin:0 auto}"

export function Picture({ render, style }: { render: StaticRender; style?: CSSProperties }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" })
    root.innerHTML = `<style>${BASE_CSS}${render.css ?? ""}</style>${render.markup}`
  }, [render])
  return <div ref={host} className="rich-host" role="img" aria-label={render.label} style={style} />
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;base64,${base64(markup)}`
}

export function ImgPicture({ render, style }: { render: StaticRender; style?: CSSProperties }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="rich-img" src={svgDataUrl(render.markup)} alt={render.label} width={Math.round(render.width)} height={Math.round(render.height)} style={style} />
}

export function ExportPicture({ render }: { render: StaticRender }) {
  return (
    <div className="rich-host" role="img" aria-label={render.label}>
      <template {...{ shadowrootmode: "open" }} dangerouslySetInnerHTML={{ __html: `<style>${BASE_CSS}${render.css ?? ""}</style>${render.markup}` }} />
    </div>
  )
}
