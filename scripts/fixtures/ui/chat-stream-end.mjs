/**
 * A long reply streams below the fold while the chat follows it, and the turn ends the way the engine ends it: the
 * part's final update, the message's completion and session.idle within milliseconds of the last delta. The
 * typewriter is still a fraction of a second behind then, so the chat must keep following until the reply has typed
 * out: its last line (and the thumbs) end up above the composer, with no scroll step to help.
 *
 *   chat-stream-end          24-character deltas (a fast model)
 *   chat-stream-end-bursty   120-character deltas (a bursty one: more left to type when the turn ends)
 */
import { backgroundChats, chat, defineScenario, NOW, openParts, partDeltas, partEnd, partStart, SEC, text, WORKSPACE_FILES } from "./_kit.mjs"

const HISTORY = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: an earlier answer long enough to push the reply below the fold, so the chat has to follow the stream as it grows, on a phone and on a desktop.`).join("\n\n")

const REPLY = `The grid re-renders because \`useCart()\` returns a new object on every render.

## What to change

1. Select only what a card needs.
2. Wrap \`ProductCard\` in \`memo\`.
3. Move the scroll listener into the header.

> Measure before and after with the React profiler.

\`\`\`ts
export const qty = (id: string) => useCart((s) => s.items[id]?.qty ?? 0)
\`\`\`

| Before | After |
|---|---|
| 31 ms | 6 ms |

${HISTORY}

The last line of the reply, which must end up in view.`

const LAST = "The last line of the reply, which must end up in view."

function make(name, size) {
  const c = chat("Why is the product grid slow on phones?", { ago: 0 })
  c.user("Tell me about the grid.")
  c.assistant([text(HISTORY, { ms: 2 * SEC })])
  c.user("And what should I change?")
  c.assistant([text(REPLY, { open: true, later: true, ms: 5 * SEC })], { open: true })
  const s = defineScenario({
    name,
    description: `A long reply streams (${size}-character deltas) and the turn ends at once: the chat follows to its last line without a scroll step.`,
    route: c.route,
    chats: [c, ...backgroundChats().filter((b) => b.title !== "Why is the product grid slow on phones?")],
    files: WORKSPACE_FILES,
  })
  const [part] = openParts(s, c.id)
  const info = s.engine.messages[c.id].find((m) => m.info.id === part.messageID).info
  s.steps = [
    {
      emit: [
        partStart(part),
        ...partDeltas(part, REPLY, size),
        partEnd(part, { text: REPLY, at: NOW }),
        { type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: "stop" } } },
        { type: "session.idle", properties: { sessionID: c.id } },
      ],
      every: 25,
    },
    { settle: true },
  ]
  s.assert = [
    { visible: "button[aria-label='Send']" },
    // Read before the screenshot grows the window for its full-page copy.
    { inView: `.chat-log p:has-text('${LAST}')`, above: "div:has(> textarea[data-composer])" },
    { inView: ".chat-log button[aria-label='Good reply']", above: "div:has(> textarea[data-composer])" },
  ]
  return s
}

const variants = [make("chat-stream-end", 24), make("chat-stream-end-bursty", 120)]

export default variants
