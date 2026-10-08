/**
 * Round 2a (docs/RENDERING.md §3.2a, §2.10 step 1): broken diagrams in a finished reply from 25 minutes ago.
 * The first (parentheses inside a node's square brackets) is fixed by the deterministic autofix and drawn,
 * marked data-rich-repaired="autofix". The second (`-->>`, an arrow flowcharts don't have) has no fix: it shows
 * its source with one line saying so. Nothing calls a model (model repair is Round 2b).
 */
import { backgroundChats, chat, defineScenario, MIN, text, WORKSPACE_FILES } from "./_kit.mjs"

const FENCE = "```"
const ANSWER = `Two sketches of the cart:

${FENCE}mermaid
flowchart LR
    A[Cart (guest)] --> B[Checkout]
    B --> C[Paid]
${FENCE}

And the retry path:

${FENCE}mermaid
flowchart LR
    A -->> B
${FENCE}

Tell me which one to keep.`

const c = chat("Two cart sketches", { ago: 25 * MIN })
c.user("Sketch the cart flow two ways.")
c.assistant([text(ANSWER, { ms: 6000 })])

/**
 * chat-rich-large (review, 2026-10-08): a 260-link flowchart would block the page for half a second while Mermaid
 * lays it out. The chat shows its source with "Too large to draw here." and Open draws it in the panel on demand.
 */
const LINKS = 260
const BIG = "flowchart TD\n" + Array.from({ length: LINKS }, (_, i) => `    n${i}[Step ${i}] --> n${(i * 7 + 3) % LINKS}`).join("\n")
const big = chat("A very big flow", { ago: 25 * MIN })
big.user("Map every step.")
big.assistant([text(`All of it:\n\n${FENCE}mermaid\n${BIG}\n${FENCE}\n\nThat's the map.`, { ms: 6000 })])

export const LARGE = defineScenario({
  name: "chat-rich-large",
  description: "A 260-link diagram: source and 'Too large to draw here.' in the chat; Open draws it in the panel.",
  route: big.route,
  chats: [big, ...backgroundChats()],
  files: WORKSPACE_FILES,
  steps: [{ click: ".chat-log figure[data-rich-kind=mermaid] .rich-note button:text-is('Open')" }, { waitFor: "[aria-label='Workspace panel'] figure[data-rich-kind=mermaid][data-rich-state=ready]" }],
  assert: [
    { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=source]", equals: 1 },
    { text: "Too large to draw here." },
    { visible: "[aria-label='Workspace panel'] figure[data-rich-kind=mermaid][data-rich-state=ready]" },
  ],
})

export const BROKEN = defineScenario({
  name: "chat-rich-broken",
  description: "Broken Mermaid: one fixed by the autofix and drawn, one shown as source with a note; no model call.",
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
  assert: [
    { count: "figure[data-rich-kind=mermaid][data-rich-repaired=autofix][data-rich-state=ready]", equals: 1 },
    { count: "figure[data-rich-kind=mermaid][data-rich-state=source] pre code", equals: 1 },
    { text: "This diagram has a syntax error, so here's its source." },
    { requests: "POST /api/oc/session/*/message", equals: 0 },
    { external: 0 },
  ],
})

const variants = [BROKEN, LARGE]

export default variants
