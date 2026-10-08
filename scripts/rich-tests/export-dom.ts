/**
 * The one browser test of test:rich (docs/RENDERING.md §3.0): esbuild bundles export-dom.entry.tsx, Playwright's
 * Chromium runs it on a blank page (no dev server). It checks:
 *   - the export's declarative shadow root: the innerHTML of a picture holding a one-rect SVG contains <rect
 *     (React children would serialize as an empty <template>)
 *   - the sanitizer (§2.12) on hostile SVG and CSS: scripts, handlers, javascript: and external URLs, foreignObject,
 *     animation, :host rules, fixed positions, image-set(), @import, escapes
 *   - that the autofix's candidates are diagrams Mermaid 11.17.2 itself accepts, and the broken inputs are not
 */
import { build } from "esbuild"
import path from "node:path"
import { chromium } from "playwright"

type Check = (ok: boolean, label: string, detail?: string) => void
type Rich = {
  exportHtml(markup: string): string
  sanitize(input: string): string | null
  styleSheet(css: string): string
  styleAttr(v: string): string | null
  parse(source: string): Promise<boolean>
  fixes(source: string): string[]
}

const ROOT = process.cwd()

export default async function run(check: Check) {
  const out = await build({
    entryPoints: [path.join(ROOT, "scripts", "rich-tests", "export-dom.entry.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    tsconfig: path.join(ROOT, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
    logLevel: "error",
  })
  const script = out.outputFiles[0].text
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    // Every request to the web the page makes, blocked and kept: rendering must not make any (Mermaid draws in the live page).
    const external: string[] = []
    await page.route(/^https?:/, (route) => {
      external.push(route.request().url())
      return route.abort()
    })
    await page.setContent("<!doctype html><html><body></body></html>")
    await page.addScriptTag({ content: script })
    const R = <T>(fn: (r: Rich, arg: string) => T | Promise<T>, arg = "") => page.evaluate(([f, a]) => new Function("r", "a", `return (${f})(r, a)`)((window as unknown as { __rich: Rich }).__rich, a), [fn.toString(), arg] as const) as Promise<T>

    // The export.
    const html = await R((r, a) => r.exportHtml(a), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
    check(html.includes('shadowrootmode="open"') && html.includes("<rect"), "export: the template's content serializes (<rect inside shadowrootmode)", html.slice(0, 300))

    // The sanitizer.
    const hostile: [string, string, (s: string | null) => boolean][] = [
      ["script element", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>', (s) => !!s && !/<script/i.test(s)],
      ["event handlers", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect onclick="alert(1)" onmouseover="x()" width="1" height="1"/></svg>', (s) => !!s && !/\son\w+=/i.test(s)],
      ["javascript: link", '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>', (s) => !!s && !/javascript:/i.test(s)],
      ["external image and use", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image href="https://e.com/a.png"/><image xlink:href="https://e.com/b.png"/><use href="https://e.com/s.svg#x"/><use href="#ok"/><rect id="ok" width="1" height="1"/></svg>', (s) => !!s && !/e\.com/i.test(s) && /id="ok"/.test(s)],
      ["data: images other than raster", '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zy8+"/><image href="data:image/png;base64,iVBORw0KGgo="/><rect width="1" height="1"/></svg>', (s) => !!s && !/svg\+xml/.test(s) && /data:image\/png/.test(s)],
      ["foreignObject", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject><rect width="1" height="1"/></svg>', (s) => !!s && !/foreignObject|<img|onerror/i.test(s)],
      ["animate and set", '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onclick" to="alert(1)"/><rect width="1" height="1"/></a></svg>', (s) => !!s && !/<animate|<set|javascript/i.test(s)],
      ["external url() in a presentation attribute", '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://e.com/p.svg#q)" width="1" height="1"/><rect fill="url(#g)" width="1" height="1"/></svg>', (s) => !!s && !/e\.com/.test(s) && /url\(#g\)/.test(s)],
      ["style attribute: external url, image-set, fixed", '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://e.com/x)" width="1" height="1"/><rect style=\'fill:image-set("https://e.com/c" 1x)\' width="1" height="1"/><rect style="position:fixed;inset:0;fill:red" width="1" height="1"/></svg>', (s) => !!s && !/e\.com|image-set|fixed/.test(s) && /fill: red/.test(s)],
      ["<style>: :host rule dropped, fixed position removed, the rest kept", '<svg xmlns="http://www.w3.org/2000/svg"><style>:host{position:fixed!important;inset:0} .a{position:fixed;fill:red} .b{fill:blue}</style><rect class="a" width="1" height="1"/></svg>', (s) => !!s && !/:host|fixed/.test(s) && /fill: blue/.test(s) && /fill: red/.test(s)],
      ["<style> with @import is emptied", '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://e.com/x.css); .a{fill:red}</style><rect width="1" height="1"/></svg>', (s) => !!s && !/@import|e\.com|fill: red/.test(s)],
      ["<style> with image-set() is emptied", '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:image-set("https://e.com/b" 1x)}</style><rect width="1" height="1"/></svg>', (s) => !!s && !/image-set|e\.com/.test(s)],
      ["<style> with a CSS escape is emptied", '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:\\75 rl(https://e.com/x)}</style><rect width="1" height="1"/></svg>', (s) => !!s && !/e\.com/.test(s)],
      ["<style> with @font-face is emptied", '<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:x;src:url(https://e.com/f.woff2)} text{font-family:x}</style><text>a</text></svg>', (s) => !!s && !/e\.com|font-face/.test(s)],
      ["a quoted string holding // or : is refused", '<svg xmlns="http://www.w3.org/2000/svg"><style>text{font-family:"https://e.com/x"}</style><text>a</text></svg>', (s) => !!s && !/e\.com/.test(s)],
      ["nothing safe left", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', (s) => s === null],
      ["not an svg", "<div>hello</div>", (s) => s === null],
      ["a CSS escape spelling url( in presentation attributes", '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L9 9" fill="\\75rl(https://e.com/f.svg#x)" stroke="\\000075rl(https://e.com/s)" mask="\\75 rl(https://e.com/m)" clip-path="u\\rl(https://e.com/c)" marker-start="\\75rl(https://e.com/a)" marker-end="\\75rl(https://e.com/b)" filter="\\75rl(https://e.com/g)"/><rect width="1" height="1"/></svg>', (s) => !!s && !/e\.com|\\/.test(s)],
      ["src() in a presentation attribute", '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="src(https://e.com/p)" width="1" height="1"/></svg>', (s) => !!s && !/e\.com/.test(s)],
      ["ids keep working", '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#g)" width="1" height="1"/></svg>', (s) => !!s && /id="g"/.test(s) && /url\(#g\)/.test(s)],
    ]
    for (const [label, input, ok] of hostile) {
      const s = await R((r, a) => r.sanitize(a), input)
      check(ok(s), `sanitize: ${label}`, String(s).slice(0, 300))
    }
    const big = "<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/>" + "<g/>".repeat(60_000) + "</svg>"
    check((await R((r, a) => r.sanitize(a), big)) === null, "sanitize: input over 200 KB is refused before parsing")
    check((await R((r, a) => r.styleAttr(a), "fill: red; position: sticky")) === "fill: red;", "style attribute: sticky position removed")

    // The autofix against Mermaid itself.
    const broken = ["flowchart LR\n    A[Cart (guest)] --> B[Checkout]", "sequenceDiagram\n    A->>B hello there;", "stateDiagram-v2\n    [*] -> Idle", 'pie title Pets\n    "Dogs" 386', "```mermaid\nflowchart LR\n    A --> B\n```"]
    for (const b of broken) {
      const before = await R((r, a) => r.parse(a), b)
      const fixed = (await R((r, a) => r.fixes(a), b))[0]
      const after = fixed !== undefined && (await R((r, a) => r.parse(a), fixed))
      check(!before && after, `autofix: Mermaid rejects "${b.split("\n").find((l) => /^\s/.test(l))?.trim()}" and accepts the fix`, `before ${before}, fix ${JSON.stringify(fixed)}, after ${after}`)
    }
    check(!(await R((r, a) => r.parse(a), "flowchart LR\n    A -->> B")), "Mermaid rejects -->> in a flowchart (chat-rich-broken's source case)")
    // Hostile Mermaid through the chat's renderer: directives can't loosen it, labels can't carry HTML, styles can't fetch or escape.
    const mermaidCases: [string, string, (s: string) => boolean][] = [
      ["click directive with javascript:", 'flowchart LR\n    A-->B\n    click A href "javascript:alert(1)"', (s) => !/javascript|<a\b[^>]*href/i.test(s)],
      ["init directive asking for loose mode and HTML labels", '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n    A["<b>bold</b>"] --> B', (s) => !/foreignObject|<b>/i.test(s) && /<svg/.test(s)],
      ["HTML in a label", 'flowchart LR\n    A["<img src=x onerror=alert(1)>"] --> B', (s) => !/<img|onerror=/i.test(s)],
      ["style with a fixed position and an external url", "flowchart LR\n    A-->B\n    style A position:fixed,fill:url(https://e.com/x)", (s) => !/position:\s*fixed|e\.com/i.test(s)],
      ["classDef with an external url", "flowchart LR\n    classDef x fill:url(https://e.com/y)\n    A:::x-->B", (s) => !/e\.com/i.test(s)],
      ["themeCSS in a directive", '%%{init: {"themeCSS": ":host{position:fixed} .node rect{fill:url(https://e.com/z)}"}}%%\nflowchart LR\n    A-->B', (s) => !/e\.com|:host/i.test(s)],
    ]
    // Sources that would make the page fetch while Mermaid lays them out (before any sanitizer): refused up front.
    const B = String.fromCharCode(92)
    const beacons: [string, string][] = [
      ["img shape", 'flowchart LR\n  A@{ img: "https://e.com/imgshape.png", label: "x", pos: "t", w: 60, h: 60, constraint: "on" }\n  A-->B'],
      ["img shape, quoted key", 'flowchart LR\n  A@{ "img": "https://e.com/imgshape2.png", label: "x" }\n  A-->B'],
      ["classDiagram style mask-image", "classDiagram\n  class A{\n  +x\n  }\n  style A fill:#f00,mask-image:url(https://e.com/clsstyle.png)"],
      ["stateDiagram classDef mask-image", "stateDiagram-v2\n  classDef bad mask-image:url(https://e.com/state.png)\n  [*] --> S1\n  class S1 bad"],
      ["stateDiagram classDef border-image", "stateDiagram-v2\n  classDef bad border-image:url(https://e.com/border.png) 30\n  [*] --> S1\n  class S1 bad"],
      ["stateDiagram classDef list-style-image", "stateDiagram-v2\n  classDef bad list-style-image:url(https://e.com/list.png)\n  [*] --> S1\n  class S1 bad"],
      ["block-beta classDef mask-image", 'block-beta\n  a["A"]\n  classDef bad mask-image:url(https://e.com/blk2.png)\n  class a bad'],
      ["flowchart classDef with a CSS-escaped url(", `flowchart LR\n  classDef x border-image:${B}75rl(https://e.com/esc.png) 30\n  A:::x-->B`],
      ["image-set()", 'stateDiagram-v2\n  classDef bad border-image:image-set("https://e.com/is.png" 1x) 30\n  [*] --> S1\n  class S1 bad'],
      ["@import through a classDef", "stateDiagram-v2\n  classDef bad fill:red;}@import url(https://e.com/imp.css);x{fill:red\n  [*] --> S1\n  class S1 bad"],
    ]
    for (const [label, src] of beacons) {
      const before = external.length
      const s = await R((r, a) => (r as unknown as { mermaidSvg(x: string): Promise<string> }).mermaidSvg(a), src)
      await page.waitForTimeout(150)
      check(s === "remote" && external.length === before, `mermaid beacon refused before drawing: ${label}`, `${s.slice(0, 80)}; fetched ${external.slice(before).join(", ")}`)
    }
    for (const [label, src, ok] of mermaidCases) {
      const s = await R((r, a) => (r as unknown as { mermaidSvg(x: string): Promise<string> }).mermaidSvg(a), src)
      check(s !== "invalid" ? ok(s) : true, `mermaid: ${label}${s === "invalid" ? " (refused as invalid)" : ""}`, (s.match(/.{0,120}(javascript|<a\b|e\.com|:host|fixed|foreignObject|<img|onerror).{0,120}/i)?.[0] ?? s).slice(0, 400))
    }
    check(external.length === 0, "nothing in this page reached the web (sanitizer, export and every Mermaid case)", external.join(", "))
    check(errors.length === 0, "no page errors", errors.join("; "))
  } finally {
    await browser.close()
  }
}
