/**
 * A finished chat whose answers use the Markdown the renderer must handle today:
 * headings, nested and numbered lists, a task list, bold and code spans, fenced code
 * blocks, a GFM table, a blockquote, inline workspace paths (which become file links)
 * and very long URLs, which must wrap so a phone never scrolls sideways.
 */
import { backgroundChats, chat, defineScenario, HOUR, MIN, text, WORKSPACE_FILES } from "./_kit.mjs"

const LONG_URL = "https://docs.stripe.com/payments/accept-a-payment?platform=web&ui=elements&client=react&server=node&lang=node#enable-apple-pay-and-google-pay-through-the-payment-element-with-domain-verification-and-wallet-settings"

const ANSWER_1 = `## Checkout in three steps

The flow lives in three files: \`src/checkout/page.tsx\` renders the form, \`src/cart.ts\` computes the totals, and \`src/api/checkout.ts\` talks to Stripe.

### 1. The cart total

\`cartTotal()\` in \`src/cart.ts:5\` adds line items in **integer cents**, so rounding happens once, on the tax line:

\`\`\`ts
export function cartTotal(items: LineItem[], taxRate: number): number {
  const subtotal = items.reduce((sum, i) => sum + toCents(i.price) * i.qty, 0)
  return (subtotal + roundCents(subtotal * taxRate)) / 100
}
\`\`\`

### 2. The payment intent

1. The browser posts the cart id to \`/api/checkout\`.
2. The server reloads prices from the database. It never trusts the client's numbers.
3. Stripe returns a \`client_secret\`, and the page mounts the Payment Element.

### 3. Where each piece lives

| File | What it does | Lines |
| --- | --- | ---: |
| \`src/checkout/page.tsx\` | Form, address fields, Payment Element | 214 |
| \`src/cart.ts\` | Totals, tax, discount codes | 96 |
| \`src/api/checkout.ts\` | Creates the PaymentIntent | 61 |
| \`src/api/webhooks/stripe.ts\` | Marks orders paid | 48 |

### Adding Apple Pay

- Turn on **Apple Pay** in the Stripe dashboard and verify the domain.
- The Payment Element shows it on Safari by itself:
  - no new component,
  - no extra API route.
- Host the domain association file under \`public/.well-known/\`.

> Stripe only shows Apple Pay on HTTPS, so test it on the preview deployment, not on localhost.

Full guide: ${LONG_URL}

I also noted this in \`docs/launch-plan.md\` under *Payments*.`

const ANSWER_2 = `Yes, with one gap. The handler in \`src/api/webhooks/stripe.ts\` checks the event id before it writes, so a retried delivery is a no-op:

\`\`\`ts
if (await db.processedEvents.has(event.id)) return new Response(null, { status: 200 })
await db.transaction(async (tx) => {
  await tx.orders.markPaid(intent.metadata.orderId)
  await tx.processedEvents.add(event.id)
})
\`\`\`

The gap: \`markPaid\` runs before the event id is stored when the transaction is skipped in tests. What I'd do:

- [x] Keep the id check first
- [x] Store the event id in the same transaction as the order update
- [ ] Add a test that delivers the same event twice
- [ ] ~~Retry failed webhooks ourselves~~ (Stripe already retries for three days)

To replay an event locally:

\`\`\`bash
stripe trigger payment_intent.succeeded --add payment_intent:metadata.orderId=1041
\`\`\`

Reference: [Stripe webhooks: best practices](https://docs.stripe.com/webhooks#best-practices) · raw endpoint https://dashboard.stripe.com/test/webhooks/we_1QrT9zLkdIwHu7ixAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyz`

const c = chat("How does checkout work?", { ago: 2 * HOUR })
c.user("Walk me through how checkout works in this repo. Which files matter, and where would I add Apple Pay?")
c.assistant([text(ANSWER_1, { ms: 6200 })], { ttft: 840 })
c.user("Thanks. Is the Stripe webhook idempotent?", { after: 3 * MIN })
c.assistant([text(ANSWER_2, { ms: 4800 })], { ttft: 760 })

export default defineScenario({
  name: "chat-markdown",
  description: "Finished chat: headings, lists, task list, code blocks, GFM table, blockquote, file links, very long URLs.",
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
  assert: [
    { visible: ".chat-log h2:text-is('Checkout in three steps')" },
    { count: ".chat-log .md-table table", equals: 1 },
    { count: ".chat-log pre", equals: 3 },
    { count: ".chat-log input[type=checkbox]", equals: 4 },
    // An inline path inside the workspace (with a line number) becomes a file link.
    { visible: ".chat-log button:has(code:text-is('src/cart.ts:5'))" },
    { visible: `.chat-log a[href="${LONG_URL}"]` },
  ],
})
