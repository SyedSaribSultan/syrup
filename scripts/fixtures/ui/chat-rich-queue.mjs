/**
 * Round 2a review (h7, 2026-10-08): diagrams render one at a time in an idle-time queue. A reader who opens a chat with
 * 30 diagrams and moves on to another chat before they have drawn must not wait for the first chat's leftovers: renders
 * whose blocks have left the screen are dropped when their turn comes (the one in flight finishes and is cached).
 *
 * Mermaid numbers its renders in order (the picture's id is rich-m1, rich-m2, …), so the new chat's diagram having
 * a low number proves it was drawn before the old chat's leftovers: with them it would be about rich-m30.
 */
import { chat, defineScenario, MIN, text, WORKSPACE_FILES } from "./_kit.mjs"

const F = "```"
const diagram = (i) => `${F}mermaid\nflowchart TD\n${Array.from({ length: 80 }, (_, j) => `  n${i}_${j}[Step ${j} of ${i}] --> n${i}_${(j * 7 + 3) % 80}`).join("\n")}\n${F}`

const start = chat("Plain start", { ago: 5 * MIN })
start.user("Hi")
start.assistant([text("Nothing to draw here. START-MARKER", { ms: 1500 })])

const many = chat("Many diagrams", { ago: 10 * MIN })
many.user("Draw lots.")
many.assistant([text(Array.from({ length: 30 }, (_, i) => `Diagram ${i}:\n\n${diagram(i)}`).join("\n\n"), { ms: 2000 })])

const one = chat("One diagram", { ago: 20 * MIN })
one.user("Draw one.")
one.assistant([text(`One:\n\n${F}mermaid\nflowchart LR\n  X[Only] --> Y[One]\n${F}\n\nEND-B`, { ms: 2000 })])

/** The new chat's picture was among the first renders of the page. */
const EARLY = Array.from({ length: 15 }, (_, i) => `#rich-m${i + 1}`).join(", ")

const MANY_READY = ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready]"

export default defineScenario({
  name: "chat-rich-queue",
  description: "Leave a chat with 30 diagrams mid-render: the next chat's diagram draws before any leftover of the first.",
  route: start.route,
  chats: [start, many, one],
  files: WORKSPACE_FILES,
  steps: [
    { click: "nav a:has-text('Many diagrams')", widths: [1440] },
    { tap: "button[aria-label='Open menu']", widths: [390] },
    { tap: "nav a:has-text('Many diagrams')", widths: [390] },
    // The queue has started: one of the 30 is drawn, the rest wait.
    { waitFor: MANY_READY },
    { click: "nav a:has-text('One diagram')", widths: [1440] },
    { tap: "button[aria-label='Open menu']", widths: [390] },
    { tap: "nav a:has-text('One diagram')", widths: [390] },
    { waitFor: ".chat-log :text('END-B')" },
    { waitFor: MANY_READY },
  ],
  assert: [
    { text: "END-B" },
    { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready]", equals: 1 },
    { count: `.chat-log figure[data-rich-kind=mermaid] svg:is(${EARLY})`, equals: 1 },
  ],
})
