/**
 * A chat opened while its reply is being written (a reload, a second tab, or the chat picked
 * from the sidebar mid-answer). OpenCode 1.18 stores a streaming part empty and replays
 * nothing, so this page can only see the deltas that arrive after it opened: the tail of the
 * reply without its beginning. It must show "Writing…" instead of that tail, and when the
 * part's final update lands, the whole reply at once (no typing it out again from the first
 * character, which took about 5 s for a reply this long). Then the turn ends.
 */
import { backgroundChats, chat, defineScenario, NOW, openParts, partDeltas, partEnd, reasoning, SEC, text, WORKSPACE_FILES } from "./_kit.mjs"

const HEAD = `The product grid re-renders every card on each scroll event because \`useCart()\` returns a new object on every render, and all 48 cards subscribe to it. React compares the object by reference, sees a change, and renders the card again even though nothing in it changed.

## What to change

1. Select only what a card needs: \`useCart((s) => s.items[id]?.qty ?? 0)\` returns a number, so a card renders again only when its own quantity changes.
2. Wrap \`ProductCard\` in \`memo\`, so a parent render with the same props skips it.
3. Move the scroll listener out of \`ProductGrid\` into the sticky header that actually uses it.

`

// What arrives over the stream after the page opened: the part's tail.
const TAIL = `## How much it saves

On a mid-range Android phone the grid went from about 31 ms per scroll frame to under 6 ms in a quick profile, so scrolling stays at 60 frames per second. The cart badge still updates at once, because the header keeps its own subscription to the item count.

If you want, I can make the change and add a test that renders the grid, changes one item's quantity and checks that only that card rendered again.`

const FULL = HEAD + TAIL
const FIRST_LINE = "The product grid re-renders every card on each scroll event"
const TAIL_LINE = "On a mid-range Android phone the grid went from about 31 ms"
const LAST_LINE = "checks that only that card rendered again."

const c = chat("Why is the product grid slow on phones?", { ago: 0 })
c.user("The product grid stutters when I scroll on my phone. Why, and what should I change?")
c.assistant(
  [
    reasoning("Scroll jank with 48 cards: likely every card re-renders per scroll event. Check how the cart store is subscribed to.", { ms: 3400 }),
    // Streaming when the page opened: served empty, as the engine stores it.
    text(HEAD, { open: true, ms: 9 * SEC }),
  ],
  { open: true },
)

const scenario = defineScenario({
  name: "chat-joined-midstream",
  description: "Chat opened mid-reply: \"Writing…\" while the unseen part streams, then the whole reply at once when it ends.",
  route: c.route,
  chats: [c, ...backgroundChats().filter((b) => b.title !== "Why is the product grid slow on phones?")],
  files: WORKSPACE_FILES,
})

const [part] = openParts(scenario, c.id)
const info = scenario.engine.messages[c.id].find((m) => m.info.id === part.messageID).info

scenario.steps = [
  { assert: { visible: ".chat-log [role=status][aria-label='Writing']" } },
  { assert: { visible: "button:text-is('Stop')" } },
  // The rest of the reply streams in: this page never saw its beginning, so it must not show it.
  { emit: partDeltas(part, TAIL), every: 15 },
  { settle: true },
  { assert: { hidden: `.chat-log :text('${TAIL_LINE}')` } },
  { assert: { visible: ".chat-log [role=status][aria-label='Writing']" } },
  // The part ends: its whole text, at once.
  { emit: partEnd(part, { text: FULL, at: NOW }) },
  { assert: { text: FIRST_LINE } },
  { assert: { text: LAST_LINE } },
  { assert: { hidden: ".chat-log [role=status][aria-label='Writing']" } },
  // Then the turn ends: Send comes back and the reply gets its thumbs.
  { emit: [{ type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: "stop" } } }, { type: "session.idle", properties: { sessionID: c.id } }] },
  { waitFor: "button[aria-label='Send']" },
]

scenario.assert = [
  { text: FIRST_LINE },
  { text: TAIL_LINE },
  { text: LAST_LINE },
  { text: "Thought for 3.4s" },
  { count: ".chat-log ol > li", equals: 3 },
  { hidden: ".chat-log [role=status][aria-label='Writing']" },
  { hidden: "button:text-is('Stop')" },
  { count: ".chat-log button[aria-label='Good reply']", equals: 1 },
  // The router's row for the step, written when it completed: the reply names the model that answered.
  { text: "Auto → Gemini 3.5 Flash" },
]

export default scenario
