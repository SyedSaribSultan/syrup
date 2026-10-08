/**
 * Round 2a (docs/RENDERING.md §2.9): the Share dialog's HTML export of a chat with diagrams, a picture and math.
 * The file holds the pictures as declarative shadow roots (an agent SVG as an <img>), math as MathML and no script;
 * opened with JavaScript off, both diagrams are there. Drawn in the light theme even from a dark page.
 *
 *   chat-rich-export        light page
 *   chat-rich-export-dark   dark page: the file still has the light tokens' colours, never the dark ones
 */
import { backgroundChats, defineScenario, WORKSPACE_FILES } from "./_kit.mjs"
import { RICH_CHAT } from "./chat-rich-fences.mjs"

/** Opens Share (the header button on desktop, ⋯ → Share on phones) and saves the HTML export. */
export const EXPORT_STEPS = [
  { click: "header button:text-is('Share')", widths: [1440] },
  { tap: "button[aria-label='Chat options']", widths: [390] },
  { tap: "[role=menuitem]:has-text('Share')", widths: [390] },
  { download: "button:text-is('HTML')", save: "export.html" },
]

// LIGHT_TOKENS.surface2 (#eceae1) and the dark --surface-2 (#2b2a25), as the browser writes them in the picture's CSS.
const LIGHT_SURFACE_2 = "fill: rgb(236, 234, 225)"
const DARK_SURFACE_2 = "rgb(43, 42, 37)"

function make(name, dark) {
  return defineScenario({
    name,
    description: dark ? "HTML export from a dark page: pictures still in the light theme." : "HTML export: diagrams as declarative shadow roots, math as MathML, no script; opened with JavaScript off.",
    route: RICH_CHAT.route,
    chats: [RICH_CHAT, ...backgroundChats()],
    files: WORKSPACE_FILES,
    colorScheme: dark ? "dark" : "light",
    steps: [...EXPORT_STEPS, { openFile: "export.html", javaScript: false }],
    assert: [
      { file: "export.html", contains: ['shadowrootmode="open"', "<rect", "<math", ...(dark ? [LIGHT_SURFACE_2] : [])], notContains: ["<script", ...(dark ? [DARK_SURFACE_2] : [])] },
      { count: "figure[data-rich-kind=mermaid] svg[aria-roledescription]", equals: 2 },
      { count: "figure[data-rich-kind=svg] img.rich-img", equals: 1 },
      { count: "math", min: 5 },
      { external: 0 },
    ],
  })
}

const variants = [make("chat-rich-export", false), make("chat-rich-export-dark", true)]

export default variants
