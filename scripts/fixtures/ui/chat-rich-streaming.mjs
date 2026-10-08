/**
 * Round 2a (docs/RENDERING.md §3.2a): a Mermaid fence streaming in front of the user.
 *
 *   chat-rich-streaming         the fence is still open: a diagram-shaped skeleton, never a half-parsed diagram,
 *                               and the half-typed source stays folded away
 *   chat-rich-streaming-close   then the closer arrives and the turn ends: the skeleton becomes the diagram in one step
 *   chat-rich-streaming-cut     the part ends without a closer (the model forgot it): the fence is final, so it is
 *                               validated; it is half a diagram, so its source shows with "This diagram was cut off."
 *   chat-rich-streaming-abort   the turn is stopped mid-fence: the part never gets an end time, but the session goes
 *                               idle, so the fence is final all the same and no skeleton is left behind
 */
import { backgroundChats, chat, defineScenario, NOW, openParts, partDeltas, partEnd, partStart, SEC, text, WORKSPACE_FILES } from "./_kit.mjs"

const FENCE = "```"
const BODY = `Here is the checkout flow:\n\n${FENCE}mermaid\nflowchart TD\n    A[Cart] --> B{Empty?}\n    B -- No --> C[Pay`
const CLOSER = `]\n${FENCE}`
const TAIL = "\nDone."
const EVERY = 25

function make(name, close) {
  const c = chat("Sketch the checkout flow", { ago: 0 })
  c.user("Sketch the checkout flow as a diagram.")
  c.assistant([text(BODY + (close ? CLOSER + TAIL : ""), { open: true, later: true, ms: 4 * SEC })], { open: true })
  const s = defineScenario({
    name,
    description: close ? "An open ```mermaid fence closes and the turn ends: the skeleton becomes the diagram." : "A ```mermaid fence still streaming: a skeleton of the diagram's shape, no parsing.",
    route: c.route,
    chats: [c, ...backgroundChats().filter((b) => b.title !== "Sketch the checkout flow")],
    files: WORKSPACE_FILES,
  })
  const [reply] = openParts(s, c.id)
  const info = s.engine.messages[c.id].find((m) => m.info.id === reply.messageID).info
  s.steps = [{ emit: [partStart(reply), ...partDeltas(reply, BODY)], every: EVERY }, { settle: true }]
  if (!close) {
    s.assert = [
      { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=pending]", equals: 1 },
      { count: ".chat-log svg[aria-roledescription]", equals: 0 },
      { hidden: "text=C[Pay" },
      { text: "Drawing a diagram · 3 lines" },
    ]
    return s
  }
  s.steps.push(
    { assert: { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=pending]", equals: 1 } },
    { emit: partDeltas(reply, CLOSER + TAIL), every: EVERY },
    {
      emit: [
        partEnd(reply, { text: BODY + CLOSER + TAIL, at: NOW }),
        { type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: "stop" } } },
        { type: "session.idle", properties: { sessionID: c.id } },
      ],
    },
    { settle: true },
  )
  s.assert = [
    { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready]", equals: 1 },
    { count: ".chat-log figure[data-rich-state=pending]", equals: 0 },
    { text: "Done." },
    { hidden: "button:text-is('Stop')" },
    // The finished diagram is followed to its end, with the thumbs above the composer.
    { inView: ".chat-log button[aria-label='Good reply']", above: "div:has(> textarea[data-composer])" },
  ]
  return s
}

/** The fence never closes: the part ends without a closer (`cut`), or the session goes idle with the part still open (`abort`). */
function unclosed(name, how) {
  const s = make(name, false)
  const c = s.engine.sessions.find((x) => s.route.endsWith(x.id))
  const [reply] = openParts(s, c.id)
  const info = s.engine.messages[c.id].find((m) => m.info.id === reply.messageID).info
  s.name = name
  s.description = how === "cut" ? "The part ends inside an open mermaid fence: the half diagram shows as source, cut off." : "The turn is stopped inside an open mermaid fence: the block is final, no skeleton stays."
  s.steps.push(
    {
      emit: [
        ...(how === "cut" ? [partEnd(reply, { text: BODY, at: NOW })] : []),
        { type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: how === "cut" ? "stop" : "abort" } } },
        { type: "session.idle", properties: { sessionID: c.id } },
      ],
    },
    { settle: true },
  )
  s.assert = [
    { count: ".chat-log figure[data-rich-state=pending]", equals: 0 },
    { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=source]", equals: 1 },
    { text: "This diagram was cut off." },
    { hidden: "button:text-is('Stop')" },
  ]
  return s
}

const variants = [make("chat-rich-streaming", false), make("chat-rich-streaming-close", true), unclosed("chat-rich-streaming-cut", "cut"), unclosed("chat-rich-streaming-abort", "abort")]

export default variants
