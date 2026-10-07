/**
 * Every tool row the chat renders, in a real fix-and-test turn: reasoning, grep, read,
 * write, an edit that failed (a tool error: the old text didn't match), the edit that
 * worked, a patch ("Edited 2 files"), a test run the engine stopped at its timeout (watch
 * mode), a test run that passed, todowrite and step-finish; then a second turn whose bash
 * is still running, so the session is busy and the row animates. The first turn's summary
 * diffs feed the Changes button and badge. Titles and outputs are OpenCode 1.18.32's.
 */
import { abs, backgroundChats, bashResult, chat, defineScenario, diff, patch, reasoning, readResult, SEC, slashed, SOURCES, text, tool, WORKSPACE, WORKSPACE_FILES } from "./_kit.mjs"

const REASONING = `The total is computed in floating-point dollars. 3 × 19.99 is stored as 59.969999…, tax at 8.25% adds 4.947524…, and toFixed(2) on the sum lands on the right cent here only by luck; other baskets round the other way because binary floats can't hold most cent values exactly.

Fix: do the arithmetic in integer cents and round the tax once, half-up, which is what Stripe charges. A small money.ts keeps the conversion in one place.`

const GREP = `Found 2 matches
${abs("src/cart.ts")}:
  Line 6:   return Number((subtotal + tax).toFixed(2))

${abs("src/checkout/summary.tsx")}:
  Line 31:       <dd>{total.toFixed(2)}</dd>`

// The model's first try used tabs; the file is indented with spaces.
const WRONG_OLD = "\tconst tax = subtotal * taxRate\n\treturn Number((subtotal + tax).toFixed(2))"
const EDIT_FAILED = "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."

// What Vitest prints in watch mode before it waits for file changes, until the engine stops it.
const WATCH = ` DEV  v4.1.0 C:/Users/dev/code/acme-shop

 ✓ src/money.test.ts (5 tests) 3ms
 ✓ src/cart.test.ts (6 tests) 4ms
 ✓ src/checkout/address.test.ts (3 tests) 11ms

 Test Files  3 passed (3)
      Tests  14 passed (14)
   Start at  09:25:12
   Duration  640ms

 PASS  Waiting for file changes...
       press h to show help, press q to quit
`

const VITEST = ` RUN  v4.1.0 C:/Users/dev/code/acme-shop

 ✓ src/money.test.ts (5 tests) 3ms
 ✓ src/cart.test.ts (6 tests) 4ms
 ✓ src/checkout/address.test.ts (3 tests) 11ms

 Test Files  3 passed (3)
      Tests  14 passed (14)
   Start at  09:27:41
   Duration  612ms (transform 88ms, setup 0ms, collect 141ms, tests 18ms, environment 0ms, prepare 201ms)
`

const TODOS = [
  { id: "1", content: "Compute cart totals in integer cents", status: "completed", priority: "high" },
  { id: "2", content: "Run the test suite once (not watch mode)", status: "completed", priority: "high" },
  { id: "3", content: "Check the order summary still formats two decimals", status: "in_progress", priority: "medium" },
]

const SUMMARY = `Fixed. \`cartTotal()\` now adds line items in integer cents and rounds the tax once, half-up, so 3 × $19.99 at 8.25% comes to **$64.92** every time, matching what Stripe charges.

- New \`src/money.ts\` with \`toCents()\` and \`roundCents()\`
- \`src/cart.ts\` uses them instead of \`toFixed(2)\`
- All 14 tests pass (the first run hung in watch mode, so I ran \`vitest run\`)`

const c = chat("Fix the cart rounding bug", { ago: 0 })
c.user("Some carts are a cent off at checkout, e.g. 3 × $19.99 with 8.25% tax. Find the bug, fix it and run the tests.", {
  diffs: [diff("src/cart.ts", SOURCES.cartBefore, SOURCES.cartAfter), diff("src/money.ts", "", SOURCES.money)],
})
c.assistant([
  reasoning(REASONING, { ms: 4200 }),
  tool("grep", { pattern: "toFixed", include: "*.{ts,tsx}" }, { output: GREP, metadata: { matches: 2 }, ms: 300 }),
  tool("read", { filePath: abs("src/cart.ts") }, { ...readResult("src/cart.ts", SOURCES.cartBefore), ms: 200 }),
  tool("write", { filePath: abs("src/money.ts"), content: SOURCES.money }, { output: "Wrote file successfully.", metadata: { diagnostics: {}, filepath: abs("src/money.ts"), exists: false }, ms: 400 }),
  tool("edit", { filePath: abs("src/cart.ts"), oldString: WRONG_OLD, newString: "  return (subtotal + roundCents(subtotal * taxRate)) / 100" }, { status: "error", error: EDIT_FAILED, ms: 40 }),
  tool("edit", { filePath: abs("src/cart.ts"), oldString: SOURCES.cartBefore, newString: SOURCES.cartAfter }, { output: "Edit applied successfully.", metadata: { diagnostics: {}, diff: diff("src/cart.ts", SOURCES.cartBefore, SOURCES.cartAfter).patch }, ms: 350 }),
  patch([slashed("src/money.ts"), slashed("src/cart.ts")]),
])
c.assistant([
  tool("bash", { command: "pnpm test", description: "Run the test suite" }, { ...bashResult(WATCH, { timeoutMs: 120_000 }), ms: 120 * SEC }),
  tool("bash", { command: "pnpm vitest run", description: "Run the tests once" }, { ...bashResult(VITEST), ms: 2400 }),
])
c.assistant([tool("todowrite", { todos: TODOS }, { output: JSON.stringify(TODOS, null, 2), metadata: { todos: TODOS }, ms: 100 }), text(SUMMARY, { ms: 2600 })])
c.user("Great. Run the production build too, to be sure.", { after: 40 * SEC })
// Running: no title yet (the row shows the command); bash streams its output into metadata.
c.assistant([tool("bash", { command: "pnpm build", description: "Production build", workdir: WORKSPACE }, { status: "running", metadata: { output: "   ▲ Next.js 16.3.5\n   Creating an optimized production build ...\n" }, ms: 12 * SEC })], { open: true })

export default defineScenario({
  name: "chat-tools",
  description: "Tool rows: reasoning, grep, read, write, failed and applied edit, patch, bash stopped at timeout/passed/running, todowrite; busy session.",
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
  steps: [
    // Open the reasoning, the failed edit and the run that hit its timeout, so their bodies are in the full screenshot
    // (each row's own toggle: the middle of a row can be its file link, which opens the file instead),
    { click: ".chat-log button:has-text('Thought for 4.2s')" },
    { click: ".chat-log div.cursor-pointer:has(span.bg-err) > button[aria-expanded]" },
    { click: ".chat-log div.cursor-pointer:has-text('pnpm test') > button[aria-expanded]" },
    // then go back to the end, where a reader of a busy chat is.
    { scroll: [".chat-log >> xpath=..", "bottom"] },
  ],
  assert: [
    { text: "Thought for 4.2s" },
    { text: "Could not find oldString in the file." },
    { text: "shell tool terminated command after exceeding timeout 120000 ms" },
    { count: ".chat-log span.bg-err", equals: 1 },
    { text: "Update plan" },
    { text: "Edited 2 files:" },
    { visible: ".chat-log [role=status]:has-text('Running')" },
    // Busy: the composer offers Stop instead of Send.
    { visible: "button:text-is('Stop')" },
    { visible: "button[title='Files the agent changed in this chat']:has-text('Changes')", widths: [1440] },
  ],
})
