/**
 * The streaming-text code (src/lib/use-typewriter.ts) loads on first use, as its own chunk. When that chunk can't
 * load (offline when the chat opened, or a tab left open across a deploy that removed the old chunks), the reply
 * still shows, as plain text without the typewriter. It used to take the whole page down to "This page couldn't
 * load" on the first streamed word.
 */
import { backgroundChats, chat, defineScenario, NOW, openParts, partDeltas, partEnd, partStart, reasoning, SEC, text, WORKSPACE_FILES } from "./_kit.mjs"

const BODY = "Here is the plan for the import script.\n\nFirst, read the CSV with DictReader.\n\nThen insert every row in one transaction."
const LAST = "Then insert every row in one transaction."

const c = chat("Import orders into SQLite", { ago: 0 })
c.user("Write a Python script that loads data/orders.csv into SQLite.")
c.assistant([reasoning("Plan first.", { ms: 2100 }), text(BODY, { open: true, later: true, ms: 7 * SEC })], { open: true })

const scenario = defineScenario({
  name: "chat-streaming-offline",
  description: "The streaming-text chunk fails to load: the reply shows as plain text and the chat stays on screen.",
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
  // Turbopack names the chunk after the module (dev): src_lib_use-typewriter_ts_….js.
  block: ["**/*use-typewriter*"],
})

const [part] = openParts(scenario, c.id)
const info = scenario.engine.messages[c.id].find((m) => m.info.id === part.messageID).info

scenario.steps = [
  { emit: [partStart(part), ...partDeltas(part, BODY)], every: 20 },
  { settle: true },
  { assert: { text: "First, read the CSV with DictReader." } },
  { assert: { hidden: ":text('This page couldn')" } },
  {
    emit: [
      partEnd(part, { text: BODY, at: NOW }),
      { type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: "stop" } } },
      { type: "session.idle", properties: { sessionID: c.id } },
    ],
  },
  { settle: true },
]

scenario.assert = [
  { text: "Write a Python script that loads data/orders.csv" },
  { text: LAST },
  { visible: "button[aria-label='Send']" },
  { hidden: ":text('This page couldn')" },
]

export default scenario
