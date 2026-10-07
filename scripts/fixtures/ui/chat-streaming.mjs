/**
 * A turn caught mid-stream: the session is busy and the last assistant message has
 * no completed time; its text part has no end time and stops inside an unclosed
 * ```python fence. Round 2's rule ("a fence renders when it closes; while it streams,
 * a skeleton of the right shape") is judged on this screen.
 *
 * As OpenCode 1.18 does it, the streaming part is stored empty and its text so far
 * arrives as message.part.delta events. The client ignores those today (only
 * message.part.updated reaches the screen), so the reply shows no text until the part
 * ends: the assertions on the text are known gaps until the client applies deltas.
 */
import { abs, backgroundChats, chat, defineScenario, readResult, reasoning, SEC, text, tool, WORKSPACE_FILES } from "./_kit.mjs"

const DELTAS_IGNORED = "OpenCode 1.18 streams text only as message.part.delta events and stores the part empty until it ends; src/lib/engine-store.tsx ignores message.part.delta, so a streaming reply shows no text"

// Cut mid-statement inside the code block: the closing ``` has not arrived yet.
const STREAMED = `I'll read \`data/orders.csv\` with the standard \`csv\` module and insert every row in one transaction, so a bad row rolls the whole import back instead of leaving half an import behind.

Save this as \`scripts/import_orders.py\`:

\`\`\`python
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

const c = chat("Import orders into SQLite", { ago: 0 })
c.user("Write a Python script that loads data/orders.csv into a SQLite database, one row per order. Amounts in cents, please.")
c.assistant(
  [
    reasoning("The CSV has a header row and quoted names (\"Chen, Wei\"), so csv.DictReader is the safe parser. Money goes in as integer cents.", { ms: 2100 }),
    tool("read", { filePath: abs("data/orders.csv"), limit: 3 }, { ...readResult("data/orders.csv", WORKSPACE_FILES["data/orders.csv"], { limit: 3 }), ms: 150 }),
    text(STREAMED, { open: true, ms: 7 * SEC }),
  ],
  { open: true },
)

export default defineScenario({
  name: "chat-streaming",
  description: "Busy session; the last reply is still streaming and stops inside an unclosed ```python fence.",
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
  // The view sticks to the bottom only when new message entries arrive, and the deltas all land at once
  // right after loading, so scroll down to the open fence the way a reader would.
  steps: [{ scroll: [".chat-log >> xpath=..", "bottom"] }],
  assert: [
    // The finished parts of the streaming message, and the busy composer.
    { text: "Thought for 2.1s" },
    { text: "data\\orders.csv" },
    { visible: "button:text-is('Stop')" },
    { text: "Save this as", gap: DELTAS_IGNORED },
    { text: '(int(r["order_id"]), r["placed_at"], r["customer"],', gap: DELTAS_IGNORED },
    { count: ".chat-log pre", equals: 1, gap: DELTAS_IGNORED },
  ],
})
