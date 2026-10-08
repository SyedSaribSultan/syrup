/**
 * For pnpm ui:weight --budgets (W1, docs/RENDERING.md §3.0): one finished reply holding one kind of rich block each,
 * so the JavaScript and CSS a kind adds after load can be measured against chat-markdown's.
 *
 *   weight-mermaid   one flowchart: the core, Mermaid's common diagrams, DOMPurify
 *   weight-math      inline and display math: the math parser and KaTeX (JS + CSS)
 *   weight-svg       one agent SVG: the core and DOMPurify
 */
import { backgroundChats, chat, defineScenario, MIN, text, WORKSPACE_FILES } from "./_kit.mjs"

const FENCE = "```"

const BODIES = {
  "weight-mermaid": `The flow:\n\n${FENCE}mermaid\nflowchart TD\n    A[Cart] --> B{Empty?}\n    B -- Yes --> C[Empty state]\n    B -- No --> D[Checkout]\n${FENCE}`,
  "weight-math": String.raw`The total is $\sum_i q_i c_i$ in cents:` + "\n\n$$\n" + String.raw`\text{total} = \sum_{i=1}^{n} q_i c_i` + "\n$$",
  "weight-svg": `The mark:\n\n${FENCE}svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40"><rect width="120" height="40" rx="8" fill="#c8623f"/><text x="60" y="26" text-anchor="middle" font-size="16" fill="#fff">acme</text></svg>\n${FENCE}`,
}

export default Object.entries(BODIES).map(([name, body]) => {
  const c = chat(`Weight probe ${name.slice(7)}`, { ago: 30 * MIN })
  c.user("Show it.")
  c.assistant([text(body, { ms: 2000 })])
  return defineScenario({
    name,
    description: `ui:weight --budgets only: one ${name.slice(7)} block in a finished reply.`,
    route: c.route,
    chats: [c, ...backgroundChats()],
    files: WORKSPACE_FILES,
    assert: [{ count: ".chat-log :is(figure.rich[data-rich-state=ready], .rich-tex[data-rich-state=ready], .rich-tex-display[data-rich-state=ready])", min: 1 }],
  })
})
