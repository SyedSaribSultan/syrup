/**
 * Acceptance fixture for Rounds 2–3 (docs/ROADMAP.md): one finished assistant reply
 * with every rich fence the chat will learn to draw. Round 2a draws the flowchart, the
 * sequence diagram, the SVG and the math; the bar chart, the table and the mind map stay
 * code blocks until Round 3. Every block is valid on its own (Mermaid 11, Vega-Lite 5, SVG 1.1, KaTeX,
 * RFC 4180 CSV, markmap), so a renderer that fails here has a bug, not bad input.
 */
import { backgroundChats, chat, defineScenario, MIN, text, WORKSPACE_FILES } from "./_kit.mjs"

const FLOWCHART = `flowchart TD
    A[Customer opens the cart] --> B{Cart empty?}
    B -- Yes --> C[Show the empty state]
    B -- No --> D[Compute totals in cents]
    D --> E[Apply discount code]
    E --> F{Payment method}
    F -- Card or wallet --> G[Stripe Payment Element]
    F -- Bank transfer --> H[Show transfer details]
    G --> I[Webhook marks the order paid]
    H --> I
    I --> J([Confirmation email])`

const SEQUENCE = `sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API route
    participant S as Stripe
    participant D as Database
    B->>A: POST /api/checkout (cart id)
    A->>D: Load cart and current prices
    D-->>A: Line items
    A->>S: Create PaymentIntent (amount in cents)
    S-->>A: client_secret
    A-->>B: 200 with clientSecret
    B->>S: Confirm payment
    S-)A: Webhook payment_intent.succeeded
    A->>D: Mark order paid (idempotent)`

const VEGA = JSON.stringify(
  {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Orders per weekday, last four weeks",
    width: "container",
    height: 220,
    data: {
      values: [
        { day: "Mon", orders: 42 },
        { day: "Tue", orders: 38 },
        { day: "Wed", orders: 51 },
        { day: "Thu", orders: 47 },
        { day: "Fri", orders: 63 },
        { day: "Sat", orders: 71 },
        { day: "Sun", orders: 29 },
      ],
    },
    mark: { type: "bar", cornerRadiusEnd: 3, tooltip: true },
    encoding: {
      x: { field: "day", type: "nominal", sort: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], title: null, axis: { labelAngle: 0 } },
      y: { field: "orders", type: "quantitative", title: "Orders" },
    },
  },
  null,
  2,
)

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" width="320" height="120" role="img" aria-label="acme shop logo draft">
  <rect x="4" y="4" width="312" height="112" rx="16" fill="#fbf3e4" stroke="#b5651d" stroke-width="2"/>
  <g transform="translate(60 60)">
    <circle r="34" fill="#b5651d"/>
    <path d="M-16 -4h32l-4 22h-24z" fill="#fbf3e4"/>
    <path d="M-10 -4a10 10 0 0 1 20 0" fill="none" stroke="#fbf3e4" stroke-width="4"/>
  </g>
  <text x="112" y="58" font-family="Georgia, serif" font-size="28" fill="#3b2a1a">acme shop</text>
  <text x="112" y="84" font-family="system-ui, sans-serif" font-size="13" fill="#7a6552">logo draft v2, warm palette</text>
</svg>`

/** Twenty days of orders, header included: date, orders, revenue, average order, refunds. */
const CSV = (() => {
  const rows = ["date,orders,revenue_usd,avg_order_usd,refunds"]
  const orders = [31, 28, 35, 41, 38, 52, 47, 33, 29, 36, 44, 40, 57, 61, 34, 30, 39, 46, 43, 66]
  const avg = [48.02, 51.3, 46.75, 49.9, 47.12, 53.48, 50.06, 45.61, 48.83, 52.27, 49.15, 47.9, 54.32, 55.08, 46.2, 49.47, 51.94, 48.36, 50.71, 56.13]
  for (let i = 0; i < 20; i++) {
    const day = new Date(Date.UTC(2026, 8, 16 + i)).toISOString().slice(0, 10)
    rows.push(`${day},${orders[i]},${(orders[i] * avg[i]).toFixed(2)},${avg[i].toFixed(2)},${[1, 0, 2, 0, 1, 3, 0, 0, 1, 0, 2, 1, 0, 4, 1, 0, 0, 2, 1, 3][i]}`)
  }
  return rows.join("\n")
})()

const MINDMAP = `# Launch: acme-shop 1.0

## Payments
- Stripe live keys
- Webhook endpoint
- Apple Pay domain

## Catalog
- 48 product photos
- Copy review

## Shipping
- EU and UK rates
- Free shipping over 75 USD

## Marketing
- Launch email
- Two social posts
- Autumn banner`

const FENCE = "```"
const ANSWER = `Here's everything for the launch review in one place.

### Checkout flow

${FENCE}mermaid
${FLOWCHART}
${FENCE}

### Payment sequence

${FENCE}mermaid
${SEQUENCE}
${FENCE}

### Orders per weekday

Saturday is the busiest day; Sunday the quietest.

${FENCE}vega-lite
${VEGA}
${FENCE}

### Logo draft

${FENCE}svg
${SVG}
${FENCE}

### Why the totals are now exact

Each floating-point addition can be off by half a unit in the last place, and the tiered discount squares the basket size, $x^2$, which amplifies that drift. In integer cents the total is exact:

$$
\\text{total} = \\sum_{i=1}^{n} q_i c_i + \\left\\lfloor r \\sum_{i=1}^{n} q_i c_i + \\frac{1}{2} \\right\\rfloor
$$

where $c_i$ is the unit price in cents, $q_i$ the quantity and $r$ the tax rate.

### Last twenty days

${FENCE}csv
${CSV}
${FENCE}

### Launch at a glance

${FENCE}markmap
${MINDMAP}
${FENCE}

Tell me which of these should go into \`docs/launch-plan.md\`.`

const c = chat("Diagrams and data for the launch review", { ago: 25 * MIN })
c.user("For the launch review: sketch the checkout flow and the payment sequence, chart orders per weekday, draft a logo as SVG, show the rounding formula, give me the last twenty days as CSV and outline the launch as a mind map.")
c.assistant([text(ANSWER, { ms: 14_000 })], { ttft: 1100 })

/** The chat, for the other Round 2a scenarios that reuse it (zoom, export). */
export const RICH_CHAT = c
export const RICH_ANSWER = ANSWER

const assert = [
  // Round 2a draws Mermaid, SVG and math; a round that turns another fence into a visual changes its line here.
  { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready] svg[aria-roledescription]", equals: 2 },
  { count: ".chat-log pre code.language-mermaid", equals: 0 },
  // .rich-host keeps the toolbar's icons out of the count.
  { count: ".chat-log figure[data-rich-kind=svg][data-rich-state=ready] .rich-host svg", equals: 1 },
  { count: ".chat-log .katex", equals: 5 },
  { count: ".chat-log .katex-display", equals: 1 },
  { hidden: "text=$x^2$" },
  { count: ".chat-log pre code.language-vega-lite", equals: 1 },
  { count: ".chat-log pre code.language-csv", equals: 1 },
  { count: ".chat-log pre code.language-markmap", equals: 1 },
  // Drawing never calls a model (repair is Round 2b) and never reaches another origin.
  { requests: "POST /api/oc/session/*/message", equals: 0 },
  { external: 0 },
  // Seven 44 px buttons wouldn't fit a phone's column (358 px at 390: the chat's 16 px gutters): label, Open and ⋯ only.
  { box: ".chat-log figure.rich .rich-bar", maxWidth: 358, widths: [390] },
  { count: ".chat-log figure.rich .rich-bar button", max: 6, widths: [390] },
]

const base = {
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
  assert,
}

const variants = [
  defineScenario({ ...base, name: "chat-rich-fences", description: "Rounds 2–3 acceptance: mermaid flowchart + sequence, vega-lite bar chart, svg, inline and display math, 20-row csv, markmap." }),
  defineScenario({ ...base, name: "chat-rich-fences-dark", description: "The same in dark mode: Mermaid in the app's dark tokens, the agent SVG on a light paper card.", colorScheme: "dark" }),
]

export default variants
