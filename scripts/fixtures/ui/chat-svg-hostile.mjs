/**
 * Round 2a security (docs/RENDERING.md §2.12, §3.2a): agent SVG is markup on syrup's origin, so a reply holds the
 * worst a model could be talked into writing. Five ```svg fences:
 *   1. the spike's hostile SVG: scripts (each would write PWNED), event handlers, a javascript: link, external
 *      images and <use>, <foreignObject> with an <img onerror>, <animate>/<set> rewriting href and handlers, a
 *      CSS url() to another origin, and <style> rules aimed at the app (hide the chat, colour the page)
 *   2. a second SVG reusing id="g": shadow roots keep ids apart
 *   3. a :host rule that would cover the whole window (the clip confines it; the sanitizer drops it)
 *   4. image-set(), which fetches without url(), from a <style> rule and from a style attribute
 *   5. a CSS escape spelling url( in presentation attributes (fill, marker-end, mask), which are CSS to the browser
 * Each draws (what is left is still a picture), nothing runs, nothing is fetched, nothing covers the composer.
 *
 *   chat-svg-hostile          the live chat
 *   chat-svg-hostile-export   the same chat exported as HTML, the file opened with JavaScript on, then off
 */
import { backgroundChats, chat, defineScenario, MIN, text, WORKSPACE_FILES } from "./_kit.mjs"
import { EXPORT_STEPS } from "./chat-rich-export.mjs"

const PWN = `document.body.insertAdjacentText("beforeend","PWNED")`

const EVIL = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="220" height="90" viewBox="0 0 220 90" onload='${PWN}'>
<script>${PWN}</script>
<style>body{background:red !important} .chat-log{display:none} .t{fill:#0a0;font:bold 14px sans-serif} @import url(https://example.com/x.css);</style>
<style>.t2{fill:#00a} body{outline:5px solid red}</style>
<defs><linearGradient id="g"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs>
<rect width="220" height="90" rx="10" fill="url(#g)"/>
<a href="javascript:${PWN}"><text class="t" x="12" y="28">click me</text></a>
<text class="t2" x="12" y="50" onclick='${PWN}'>second style</text>
<image href="https://example.com/track.png" width="10" height="10"/>
<image xlink:href="https://example.com/track2.png" width="10" height="10"/>
<use href="https://example.com/sprite.svg#x"/><use href="#g"/>
<foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror='${PWN}'/></div></foreignObject>
<animate attributeName="href" to="javascript:${PWN}"/>
<set attributeName="onmouseover" to='${PWN}'/>
<rect style="fill:url(https://example.com/x.svg#y)" width="5" height="5"/>
<rect fill="url(https://example.com/p.svg#q)" x="10" width="5" height="5"/>
</svg>`

const OTHER = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="40" viewBox="0 0 220 40"><defs><linearGradient id="g"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#facc15"/></linearGradient></defs><rect width="220" height="40" fill="url(#g)"/></svg>`

const OVERLAY = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="40" viewBox="0 0 220 40"><style>:host{position:fixed!important;inset:0!important;z-index:2147483647!important} svg{position:fixed;inset:0;width:100vw;height:100vh}</style><rect width="220" height="40" fill="#8a5bc9"/></svg>`

const IMAGE_SET = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="40" viewBox="0 0 220 40"><style>rect{fill:image-set("https://example.com/b" 1x)}</style><rect width="110" height="40" fill="#1f9a9a"/><rect x="110" width="110" height="40" style='fill:image-set("https://example.com/c" 1x)'/></svg>`

const FENCE = "```"
// 5. Review finding (2026-10-08): a CSS escape spells url( in presentation attributes, which are CSS to the browser.
const B = String.fromCharCode(92)
const ESCAPED = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60" fill="#eee"/><path d="M10 10L60 50L10 50Z" fill="${B}75rl(https://example.com/escaped-fill.svg#x)" marker-end="${B}75rl(https://example.com/escaped-marker.svg#m)" mask="${B}000075rl(https://example.com/escaped-mask.svg#k)" stroke="#333"/></svg>`

export const HOSTILE_ANSWER = `Here are the five drafts.

${FENCE}svg
${EVIL}
${FENCE}

${FENCE}svg
${OTHER}
${FENCE}

${FENCE}svg
${OVERLAY}
${FENCE}

${FENCE}svg
${IMAGE_SET}
${FENCE}

${FENCE}svg
${ESCAPED}
${FENCE}

That's all of them.`

export function hostileChat() {
  const c = chat("Four logo drafts", { ago: 20 * MIN })
  c.user("Draw five logo drafts as SVG.")
  c.assistant([text(HOSTILE_ANSWER, { ms: 5000 })])
  return c
}

const c = hostileChat()

export const LIVE_CHECKS = [
  { count: "figure[data-rich-kind=svg][data-rich-state=ready]", equals: 5 },
  { hidden: "text=PWNED" },
  { visible: ".chat-log" },
  { count: "figure[data-rich-kind=svg] :is(script, foreignObject, [onload], [onclick], [onerror], animate, set, [href^='javascript'], [href^='http'], [style*='url(http'])", equals: 0 },
  // The :host one: confined to the column (box measures the first match only).
  { box: ".chat-log figure[data-rich-kind=svg] >> nth=2 >> .rich-host", maxWidth: 760 },
  { visible: "button[aria-label='Send']" },
  { external: 0 },
]

/** What must hold in the exported file, opened with and without JavaScript. */
const FILE_CHECKS = [
  { hidden: "text=PWNED" },
  { external: 0 },
  { box: "figure[data-rich-kind=svg] >> nth=2", maxWidth: 760 },
  { count: "figure[data-rich-kind=svg] img.rich-img", equals: 5 },
]

const variants = [
  defineScenario({
    name: "chat-svg-hostile",
    description: "Hostile agent SVG (scripts, handlers, external refs, :host overlay, image-set): drawn safely, nothing runs, fetches or covers the page.",
    route: c.route,
    chats: [c, ...backgroundChats()],
    files: WORKSPACE_FILES,
    // Playwright refuses a click whose target an overlay intercepts: the composer is proven uncovered.
    steps: [{ click: "textarea" }],
    assert: LIVE_CHECKS,
  }),
  defineScenario({
    name: "chat-svg-hostile-export",
    description: "The hostile SVG chat exported as HTML, opened with JavaScript on and off: nothing runs, fetches or covers the page.",
    route: c.route,
    chats: [c, ...backgroundChats()],
    files: WORKSPACE_FILES,
    steps: [
      ...EXPORT_STEPS,
      { openFile: "export.html", javaScript: true },
      ...FILE_CHECKS.map((a) => ({ assert: a })),
      { openFile: "export.html", javaScript: false },
    ],
    // The sources are in the file as escaped text ("&lt;script"); no element of theirs may be.
    assert: [{ file: "export.html", notContains: ["<script", "<foreignObject", "<animate", "<set "] }, ...FILE_CHECKS],
  }),
]


export default variants
