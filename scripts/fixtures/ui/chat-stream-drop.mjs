/**
 * The event stream drops while a reply streams in front of the user (a phone backgrounding the tab, a flaky network,
 * the engine restarting), then reconnects. The text the page watched from the first word is a true beginning, so it
 * stays on screen with "Writing…" under it. Deltas sent during the drop are lost, so the part stops growing (a tail
 * after a gap would read as the next sentence) and the rest arrives whole with the part's final update.
 */
import { backgroundChats, chat, defineScenario, NOW, openParts, partDeltas, partEnd, partStart, reasoning, SEC, text, WORKSPACE_FILES } from "./_kit.mjs"

const INTRO = "First paragraph that the page watched stream in from its first word.\n\nSecond paragraph, also seen live.\n\n"
const REST = "Third paragraph, sent while the stream was down and after it came back.\n\nLast line of the reply."
const FULL = INTRO + REST
const SEEN = "Second paragraph, also seen live."
const WRITING = ".chat-log [role=status][aria-label='Writing']"

const c = chat("Import orders into SQLite", { ago: 0 })
c.user("Write a Python script that loads data/orders.csv into SQLite.")
c.assistant([reasoning("Plan first.", { ms: 2100 }), text(FULL, { open: true, later: true, ms: 7 * SEC })], { open: true })

const scenario = defineScenario({
  name: "chat-stream-drop",
  description: "The stream drops mid-reply and reconnects: the text seen so far stays, with \"Writing…\" under it, until the part's final update.",
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
})

const [part] = openParts(scenario, c.id)
const info = scenario.engine.messages[c.id].find((m) => m.info.id === part.messageID).info

scenario.steps = [
  { emit: [partStart(part), ...partDeltas(part, INTRO)], every: 20 },
  { settle: true },
  { assert: { text: SEEN } },
  { assert: { hidden: WRITING } },
  { dropStream: true },
  { wait: 300 },
  // During the drop: what the page saw stays.
  { assert: { text: SEEN } },
  { assert: { visible: WRITING } },
  // After the reconnect, and its re-read of the chat (which has the part empty, as the engine stores it).
  { awaitStream: true },
  { wait: 1200 },
  { assert: { text: SEEN } },
  { assert: { visible: WRITING } },
  // More of the reply streams: the page can't place it after what it lost, so it waits.
  { emit: partDeltas(part, REST), every: 10 },
  { settle: true },
  { assert: { hidden: ".chat-log :text('Third paragraph, sent while')" } },
  // The part ends: the whole reply, once.
  {
    emit: [
      partEnd(part, { text: FULL, at: NOW }),
      { type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: "stop" } } },
      { type: "session.idle", properties: { sessionID: c.id } },
    ],
  },
  { settle: true },
]

scenario.assert = [
  { text: "First paragraph that the page watched" },
  { text: "Last line of the reply." },
  { count: ".chat-log p:has-text('First paragraph that the page watched')", equals: 1 },
  { hidden: WRITING },
  { visible: "button[aria-label='Send']" },
  { count: ".chat-log button[aria-label='Good reply']", equals: 1 },
]

export default scenario
