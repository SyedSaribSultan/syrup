/**
 * A messages read that the engine answered before something happened over the event stream, but that reaches the
 * page after it. The chat is opened again (from the sidebar) while its reply finishes, or the stream reconnects and
 * re-reads the chat while it does. The read's snapshot is older than what the stream already showed, so it must not
 * undo it: not blank the finished reply (the engine stored that part empty while it streamed), not drop its
 * completion, and not drop a step that started after the read was sent.
 *
 *   chat-stale-read-end         chat opened again; the reply ends and the turn completes while the read is held
 *   chat-stale-read-step        chat opened again; a new step with a tool call starts and finishes meanwhile
 *   chat-stale-read-reconnect   the stream drops; the reply ends while the reconnect's re-read is held
 */
import { abs, backgroundChats, chat, defineScenario, NOW, openParts, partDeltas, partEnd, partStart, readResult, reasoning, SEC, text, tool, WORKSPACE, WORKSPACE_FILES } from "./_kit.mjs"

const INTRO = "Here is the plan for the import script, step by step.\n\nFirst, read the CSV with DictReader.\n\n"
const REST = "Second, insert all rows in one transaction so a bad row rolls everything back.\n\nThird, print how many rows went in."
const FULL = INTRO + REST
const FIRST_LINE = "First, read the CSV with DictReader."
const LAST_LINE = "Third, print how many rows went in."
const WRITING = ".chat-log [role=status][aria-label='Writing']"

/** Away to another chat and back, so the chat view mounts again and reads the chat. */
const AWAY = [
  { click: "nav a:has-text('Add dark mode to the storefront')", widths: [1440] },
  { tap: "button[aria-label='Open menu']", widths: [390] },
  { tap: "nav a:has-text('Add dark mode to the storefront')", widths: [390] },
  { wait: 600 },
]

function replyChat(name) {
  const c = chat("Import orders into SQLite", { ago: 0 })
  c.user("Write a Python script that loads data/orders.csv into SQLite.")
  c.assistant([reasoning("Plan first.", { ms: 2100 }), text(FULL, { open: true, later: true, ms: 7 * SEC })], { open: true })
  const s = defineScenario({ name, description: "", route: c.route, chats: [c, ...backgroundChats()], files: WORKSPACE_FILES })
  const [part] = openParts(s, c.id)
  const info = s.engine.messages[c.id].find((m) => m.info.id === part.messageID).info
  // The engine ends a turn this way: the part's final update, the message's completion, then idle.
  const end = [
    partEnd(part, { text: FULL, at: NOW }),
    { type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: "stop" } } },
    { type: "session.idle", properties: { sessionID: c.id } },
  ]
  return { c, s, part, end }
}

/** What a finished turn shows: the whole reply once, no "Writing…", Send back, thumbs, the model that answered. */
const FINISHED = [
  { text: FIRST_LINE },
  { text: LAST_LINE },
  { count: `.chat-log p:has-text('${FIRST_LINE}')`, equals: 1 },
  { hidden: WRITING },
  { visible: "button[aria-label='Send']" },
  { count: ".chat-log button[aria-label='Good reply']", equals: 1 },
  { text: "Auto → Gemini 3.5 Flash" },
]

const variants = []

{
  const { c, s, part, end } = replyChat("chat-stale-read-end")
  s.description = "Chat opened again while its reply ends: the read the engine answered before the end lands after it and must not blank the reply."
  s.steps = [
    { emit: [partStart(part), ...partDeltas(part, INTRO)], every: 20 },
    { settle: true },
    { assert: { text: FIRST_LINE } },
    ...AWAY,
    { hold: c.id },
    { back: true },
    { held: c.id },
    // While that read is on its way: the rest of the reply, its final update, the turn's end.
    { emit: partDeltas(part, REST), every: 10 },
    { emit: end },
    { wait: 600 },
    { assert: { text: LAST_LINE } },
    { release: c.id },
    { wait: 800 },
    { settle: true },
  ]
  s.assert = FINISHED
  variants.push(s)
}

{
  const c = chat("Import orders into SQLite", { ago: 0 })
  c.user("Write a Python script that loads data/orders.csv into SQLite.")
  c.assistant([reasoning("Look at the CSV first.", { ms: 1500 }), tool("read", { filePath: abs("data/orders.csv") }, { ...readResult("data/orders.csv", WORKSPACE_FILES["data/orders.csv"]), ms: 150 })])
  c.busy()
  const s = defineScenario({
    name: "chat-stale-read-step",
    description: "Chat opened again while the agent starts a new step (a glob call that runs and finishes): the older read must not drop it.",
    route: c.route,
    chats: [c, ...backgroundChats()],
    files: WORKSPACE_FILES,
  })
  // A new step: an assistant message whose only parts are step-start and a glob call.
  const mid = "msg_0001d2a7c5e1StaleReadStep2"
  const t0 = NOW + 2 * SEC
  const info = { id: mid, sessionID: c.id, role: "assistant", time: { created: t0 }, parentID: s.engine.messages[c.id][0].info.id, modelID: "auto", providerID: "syrup", mode: "build", agent: "build", path: { cwd: WORKSPACE, root: WORKSPACE }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  const glob = (state) => ({ id: "prt_0001d2a7c5e2StaleReadGlob1", sessionID: c.id, messageID: mid, type: "tool", callID: "call_5e2a91", tool: "glob", state })
  s.steps = [
    ...AWAY,
    { hold: c.id },
    { back: true },
    { held: c.id },
    {
      emit: [
        { type: "message.updated", properties: { sessionID: c.id, info } },
        { type: "message.part.updated", properties: { sessionID: c.id, part: { id: "prt_0001d2a7c5e1StaleReadStart", sessionID: c.id, messageID: mid, type: "step-start" } } },
        { type: "message.part.updated", properties: { sessionID: c.id, part: glob({ status: "running", input: { pattern: "**/*.csv" }, time: { start: t0 } }) } },
        { type: "message.part.updated", properties: { sessionID: c.id, part: glob({ status: "completed", input: { pattern: "**/*.csv" }, output: "C:\\Users\\dev\\code\\acme-shop\\data\\orders.csv", title: "", metadata: { count: 1, truncated: false }, time: { start: t0, end: t0 + 40 } }) } },
      ],
    },
    { wait: 600 },
    { assert: { text: "**/*.csv" } },
    { release: c.id },
    { wait: 800 },
    { settle: true },
  ]
  s.assert = [{ text: "**/*.csv" }, { visible: ".chat-log div.cursor-pointer:has-text('Find files')" }, { text: "data\\orders.csv" }, { visible: "button:text-is('Stop')" }]
  variants.push(s)
}

{
  const { c, s, part, end } = replyChat("chat-stale-read-reconnect")
  s.description = "The event stream drops mid-reply and reconnects; the reply ends while the reconnect's re-read is held: it must not blank the reply."
  s.steps = [
    { emit: [partStart(part), ...partDeltas(part, INTRO)], every: 20 },
    { settle: true },
    { assert: { text: FIRST_LINE } },
    { hold: c.id },
    { dropStream: true },
    // The page reconnects by itself and re-reads every chat it shows; that read is held.
    { held: c.id },
    { awaitStream: true },
    { emit: partDeltas(part, REST), every: 10 },
    { emit: end },
    { wait: 600 },
    { assert: { text: LAST_LINE } },
    { release: c.id },
    { wait: 800 },
    { settle: true },
  ]
  s.assert = FINISHED
  variants.push(s)
}

export default variants
