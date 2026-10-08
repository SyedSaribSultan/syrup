/**
 * A reply streaming in front of the user. The session is busy and the page opens on the step's
 * finished parts (thinking, a read); then the answer starts the way OpenCode 1.18 sends it: an
 * empty message.part.updated, then message.part.delta events. The text must grow on screen as
 * the deltas arrive (it used to stay blank until the part ended), and a chat switched away from
 * and back to must show what it has at once, not type it out again from the first character.
 * The turn stops mid-stream inside an unclosed ```python fence: Round 2's rule ("a fence renders
 * when it closes; while it streams, a skeleton of the right shape") is judged on this screen.
 */
import { abs, backgroundChats, chat, defineScenario, openParts, partDeltas, partStart, readResult, reasoning, SEC, text, tool, WORKSPACE_FILES } from "./_kit.mjs"

// The first sentence and the line introducing the code: what has streamed when the first check runs.
const INTRO = `I'll read \`data/orders.csv\` with the standard \`csv\` module and insert every row in one transaction, so a bad row rolls the whole import back instead of leaving half an import behind.

Save this as \`scripts/import_orders.py\`:

`

// Cut mid-statement inside the code block: the closing ``` has not arrived yet.
const CODE = `\`\`\`python
import csv
import sqlite3
from pathlib import Path

DB = Path("shop.db")
CSV = Path("data/orders.csv")


def cents(value: str) -> int:
    return round(float(value) * 100)


def main() -> None:
    con = sqlite3.connect(DB)
    con.execute(
        """
        create table if not exists orders (
            order_id integer primary key,
            placed_at text not null,
            customer text not null,
            total_cents integer not null,
            status text not null
        )
        """
    )
    with CSV.open(newline="", encoding="utf-8") as f, con:
        rows = csv.DictReader(f)
        con.executemany(
            "insert or replace into orders values (?, ?, ?, ?, ?)",
            (
                (int(r["order_id"]), r["placed_at"], r["customer"],`

const LAST_LINE = '(int(r["order_id"]), r["placed_at"], r["customer"],'

const c = chat("Import orders into SQLite", { ago: 0 })
c.user("Write a Python script that loads data/orders.csv into a SQLite database, one row per order. Amounts in cents, please.")
c.assistant(
  [
    reasoning("The CSV has a header row and quoted names (\"Chen, Wei\"), so csv.DictReader is the safe parser. Money goes in as integer cents.", { ms: 2100 }),
    tool("read", { filePath: abs("data/orders.csv"), limit: 3 }, { ...readResult("data/orders.csv", WORKSPACE_FILES["data/orders.csv"], { limit: 3 }), ms: 150 }),
    // Starts after the page opened: the page watches it from its first word.
    text(INTRO + CODE, { open: true, later: true, ms: 7 * SEC }),
  ],
  { open: true },
)

const scenario = defineScenario({
  name: "chat-streaming",
  description: "Busy session; the reply streams in as deltas while the page watches, and stops inside an unclosed ```python fence.",
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
})

const [reply] = openParts(scenario, c.id)
// About 40 deltas per second, 24 characters each: a fast model.
const EVERY = 25

scenario.steps = [
  { assert: { hidden: ".chat-log :text('Save this as')" } },
  // The answer starts, and its first sentences arrive.
  { emit: [partStart(reply), ...partDeltas(reply, INTRO)], every: EVERY },
  { settle: true },
  { assert: { text: "Save this as" } },
  { assert: { count: ".chat-log pre", equals: 0 } },
  { assert: { hidden: ".chat-log [role=status][aria-label='Writing']" } },
  // Then the code, up to the cut.
  { emit: partDeltas(reply, CODE), every: EVERY },
  { settle: true },
  { assert: { text: LAST_LINE } },
  { assert: { count: ".chat-log pre", equals: 1 } },
  // Away to another chat and back: the reply is all there at once (it used to type out again from the start).
  { click: "nav a:has-text('Add dark mode to the storefront')", widths: [1440] },
  { tap: "button[aria-label='Open menu']", widths: [390] },
  { tap: "nav a:has-text('Add dark mode to the storefront')", widths: [390] },
  { wait: 800 },
  { back: true },
  { waitFor: ".chat-log :text('Thought for 2.1s')" },
  { assert: { text: LAST_LINE } },
  // The pointer leaves the sidebar row it clicked, so the screenshot doesn't show that row's hover state. The chat's
  // title stays at the top and has no hover style, also in the taller full-page shot (over the chat, a code block
  // would show its hover-only Copy button).
  { hover: "header h1", widths: [1440] },
  // Where a reader of a streaming reply is: at the open fence.
  { scroll: [".chat-log >> xpath=..", "bottom"] },
]

scenario.assert = [
  // The finished parts of the streaming message, and the busy composer.
  { text: "Thought for 2.1s" },
  { text: "data\\orders.csv" },
  { visible: "button:text-is('Stop')" },
  { text: "Save this as" },
  { text: LAST_LINE },
  { count: ".chat-log pre", equals: 1 },
]

export default scenario
