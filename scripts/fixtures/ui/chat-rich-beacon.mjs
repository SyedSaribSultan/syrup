/**
 * Round 2a security review (2026-10-08): Mermaid lays a diagram out in the live page before our sanitizer sees its
 * SVG, so a source asking for another origin used to be fetched from syrup's origin while it drew: the img shape, and
 * classDef / style CSS with url() (border-image, list-style-image, mask-image…), escaped or not. Such sources are now
 * refused before Mermaid sees them and shown as source with a note. Nothing may reach another origin, live or exported.
 *
 *   chat-rich-beacon          the live chat
 *   chat-rich-beacon-export   the HTML export (its prerender draws in the page too), opened without JavaScript
 */
import { backgroundChats, chat, defineScenario, MIN, text, WORKSPACE_FILES } from "./_kit.mjs"
import { EXPORT_STEPS } from "./chat-rich-export.mjs"

const F = "```"
const B = String.fromCharCode(92)
const ANSWER = `Four diagrams.

${F}mermaid
stateDiagram-v2
  classDef bad border-image:url(https://example.com/state-beacon.png) 30
  [*] --> Idle
  class Idle bad
${F}

${F}mermaid
flowchart LR
  A@{ img: "https://example.com/img-shape-beacon.png", label: "Logo", pos: "t", w: 60, h: 60, constraint: "on" }
  A --> B
${F}

${F}mermaid
block-beta
  a["A"]
  classDef bad mask-image:${B}75rl(https://example.com/escaped-beacon.png)
  class a bad
${F}

${F}mermaid
flowchart LR
  C[Plain] --> D[Fine]
${F}

Done.`

const c = chat("Beacon diagrams", { ago: 20 * MIN })
c.user("Draw it.")
c.assistant([text(ANSWER, { ms: 2000 })])

const base = { route: c.route, chats: [c, ...backgroundChats()], files: WORKSPACE_FILES }

const variants = [
  defineScenario({
    ...base,
    name: "chat-rich-beacon",
    description: "Mermaid sources that would fetch another origin while drawing: shown as source, nothing fetched.",
    assert: [
      { text: "Done." },
      { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=source]", equals: 3 },
      { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready]", equals: 1 },
      { text: "This diagram asks to load something from the web, so here's its source." },
      { external: 0 },
    ],
  }),
  defineScenario({
    ...base,
    name: "chat-rich-beacon-export",
    description: "The same chat exported as HTML: the prerender fetches nothing, the file holds the plain diagram only.",
    steps: [...EXPORT_STEPS, { assert: { external: 0 } }, { openFile: "export.html", javaScript: false }],
    assert: [{ count: "figure[data-rich-kind=mermaid] svg[aria-roledescription]", equals: 1 }, { external: 0 }],
  }),
]

export default variants
