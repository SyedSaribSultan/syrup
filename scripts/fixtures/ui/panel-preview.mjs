/**
 * The workspace panel's Preview tab next to a chat (desktop) or over it (phones),
 * opened the way a user does it: the panel button, Files, then the file. Two variants
 * of one chat in which the agent wrote both files: a Markdown document and a CSV table.
 * Round 4 adds file kinds here (.mmd, .vl.json, .excalidraw, .geojson, .ipynb, .svg).
 */
import { abs, backgroundChats, chat, defineScenario, diff, HOUR, patch, slashed, text, tool, WORKSPACE_FILES } from "./_kit.mjs"

const PLAN = WORKSPACE_FILES["docs/launch-plan.md"]
const ORDERS = WORKSPACE_FILES["data/orders.csv"]

const c = chat("Draft the launch plan", { ago: 5 * HOUR })
c.user("Write our launch plan to docs/launch-plan.md (checklist, owners, risks), and export last week's orders to data/orders.csv so I can check them.", {
  diffs: [diff("docs/launch-plan.md", "", PLAN.trimEnd()), diff("data/orders.csv", "", ORDERS.trimEnd())],
})
c.assistant([
  tool("write", { filePath: abs("docs/launch-plan.md"), content: PLAN }, { output: "Wrote file successfully.", ms: 500 }),
  tool("write", { filePath: abs("data/orders.csv"), content: ORDERS }, { output: "Wrote file successfully.", ms: 300 }),
  patch([slashed("docs/launch-plan.md"), slashed("data/orders.csv")]),
])
c.assistant([
  text("Done. `docs/launch-plan.md` has the checklist, owners and risks for the 20 October launch, and `data/orders.csv` holds the 24 orders from 28 September to 5 October (one refunded, one cancelled, two pending). Open either in the panel's Preview tab.", { ms: 2200 }),
])

const base = { route: c.route, chats: [c, ...backgroundChats()], files: WORKSPACE_FILES }

const variants = [
  defineScenario({
    ...base,
    name: "panel-preview",
    description: "Preview tab showing docs/launch-plan.md (Markdown: headings, task list, table, code, quote).",
    panel: { tab: "preview", file: "docs/launch-plan.md" },
    assert: [
      { visible: "[aria-label='Workspace panel'] h1:text-is('Launch plan: acme-shop 1.0')" },
      { count: "[aria-label='Workspace panel'] .md table tbody tr", equals: 4 },
      { visible: "[aria-label='Workspace panel'] .md pre" },
    ],
  }),
  defineScenario({
    ...base,
    name: "panel-preview-csv",
    description: "Preview tab showing data/orders.csv as a table (24 rows, quoted field, wide columns).",
    panel: { tab: "preview", file: "data/orders.csv" },
    assert: [
      { count: "[aria-label='Workspace panel'] table tbody tr", equals: 24 },
      { visible: "[aria-label='Workspace panel'] td:text-is('Chen, Wei')" },
    ],
  }),
]

export default variants
