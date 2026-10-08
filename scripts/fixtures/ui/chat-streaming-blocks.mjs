/**
 * How a streaming reply is cut into blocks that render once (settledBlocks in src/lib/use-typewriter.ts), and what
 * happens to them when the reply ends.
 *
 *   chat-streaming-inline-fence   A line that starts with inline ```code``` is a paragraph, not a fence (CommonMark).
 *                                 The code block after it, which has a blank line inside, must stay one block while
 *                                 it streams: it used to be cut in two at the blank line.
 *   chat-streaming-end-keeps      When the part ends, the text keeps its DOM: a code block's "Copied" state (and with
 *                                 it a selection or a sideways scroll) survives. It used to be rebuilt from scratch.
 */
import { backgroundChats, chat, defineScenario, openParts, partDeltas, partEnd, partStart, reasoning, SEC, text, WORKSPACE_FILES } from "./_kit.mjs"

function streamingChat(name, description, body) {
  const c = chat("Import orders into SQLite", { ago: 0 })
  c.user("Write a Python script that loads data/orders.csv into SQLite.")
  c.assistant([reasoning("Plan first.", { ms: 2100 }), text(body, { open: true, later: true, ms: 7 * SEC })], { open: true })
  const s = defineScenario({ name, description, route: c.route, chats: [c, ...backgroundChats()], files: WORKSPACE_FILES })
  const [part] = openParts(s, c.id)
  return { s, part }
}

const variants = []

{
  // Stops inside the code block, after the blank line and the line under it: the moment the old splitter cut it.
  const BODY = "```npm test``` runs the suite.\n\n```\nimport os\n\nprint(os.getcwd())\nprint(os.listdir())"
  const { s, part } = streamingChat("chat-streaming-inline-fence", "A line starting with inline ```code```, then a code block with a blank line: one block while it streams.", BODY)
  s.steps = [{ emit: [partStart(part), ...partDeltas(part, BODY, 8)], every: 20 }, { settle: true }]
  s.assert = [
    { text: "runs the suite." },
    { count: ".chat-log pre", equals: 1 },
    { count: ".chat-log pre:has-text('import os'):has-text('print(os.getcwd())')", equals: 1 },
    { count: ".chat-log p:has-text('print(os.getcwd())')", equals: 0 },
  ]
  variants.push(s)
}

{
  const BODY = 'First paragraph of the reply, long enough to read.\n\nSave this as `scripts/x.py`:\n\n```python\nprint("a very long line that keeps going and going so the code block is wide enough to overflow a phone column")\n```\n\nRun it with python.\n'
  const { s, part } = streamingChat("chat-streaming-end-keeps", "The part ends while a code block shows \"Copied\": the state survives the end.", BODY)
  s.steps = [
    { emit: [partStart(part), ...partDeltas(part, BODY)], every: 20 },
    { settle: true },
    { assert: { text: "Run it with python." } },
    { click: ".chat-log .group\\/code button" },
    { assert: { visible: ".chat-log button:text-is('Copied')" } },
    { emit: partEnd(part) },
    { wait: 100 },
    // Well inside the button's 1.5 s reset.
    { assert: { visible: ".chat-log button:text-is('Copied')" } },
  ]
  s.assert = [{ text: "Run it with python." }, { count: ".chat-log pre", equals: 1 }]
  variants.push(s)
}

export default variants
