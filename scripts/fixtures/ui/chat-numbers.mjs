/**
 * Q3 (docs/QUALITY.md §Q3): the quiet note under a finished answer whose numbers don't add up, and Fix numbers.
 *
 *   chat-numbers            a finished chat: an earlier answer with right numbers gets no note; the last one (the K2
 *                           incident's shape: a stale total and every PKR figure 10x) gets one note listing what is
 *                           off. Fix numbers sends those discrepancies as the next message and goes away.
 *   chat-numbers-dark       the same in dark mode, with the button's flag off (its default: the checker's blind
 *                           precision is under 95%, QUALITY.md Q3), so the note shows without Fix numbers
 *   chat-numbers-streaming  the wrong answer streams in front of the user: no note while it streams or types out,
 *                           then the note, followed into view above the composer
 *
 * chat-numbers and -streaming turn the button's flag on (localStorage "syrup.fix-numbers" = "on").
 * The wrong answer is planted on purpose: `numbers` labels it for scripts/test-numbers.mjs and
 * scripts/test-eval-checks.mjs (which expect exactly these findings here, and none in any other fixture chat).
 */
import { backgroundChats, chat, defineScenario, NOW, openParts, partDeltas, partEnd, partStart, SEC, text, WORKSPACE_FILES } from "./_kit.mjs"

const RIGHT = `For a Pakistani climber with a local operator, budget roughly:

| Item | USD |
|---|---|
| Permit and royalty | $5,000 – $9,500 |
| Base camp services | $8,000 – $15,000 |
| Gear | $5,000 – $10,000 |
| Flights | $1,500 – $3,500 |
| **Total** | **$19,500 – $38,000** |`

const WRONG = `Using about 277 PKR per USD:

| Item | USD | PKR |
|---|---|---|
| Permit and royalty | $5,000 – $9,500 | 1.39 – 2.63 crore |
| Base camp services | $8,000 – $15,000 | 2.22 – 4.16 crore |
| Gear | $5,000 – $10,000 | 1.39 – 2.77 crore |
| Flights | $1,500 – $3,500 | 41.6 – 97 lakh |
| **Total** | **$15,000 – $25,000** | **5.4 – 10.5 crore** |

Most of the spread is the base camp package: a full-board one costs about twice a basic one.`

const QUESTION = "And the cost in PKR?"

function base(name, opts = {}) {
  const c = chat("K2 for a Pakistani climber", { ago: 0 })
  c.user("Roughly what does K2 cost for a Pakistani climber?")
  c.assistant([text(RIGHT)])
  c.user(QUESTION)
  c.assistant([text(WRONG, opts.stream ? { open: true, later: true, ms: 3 * SEC } : {})], opts.stream ? { open: true } : {})
  const s = defineScenario({
    name,
    description: opts.description,
    route: c.route,
    chats: [c, ...backgroundChats()],
    files: WORKSPACE_FILES,
    ...(opts.colorScheme && { colorScheme: opts.colorScheme }),
    ...(opts.fix && { storage: { "syrup.fix-numbers": "on" } }),
  })
  const msgs = s.engine.messages[c.id]
  const [, rightMsg, , wrongMsg] = msgs
  s.numbers = { [rightMsg.info.id]: "right", [wrongMsg.info.id]: "wrong" }
  return { s, c, wrongMsg }
}

const NOTE = ".chat-log [data-number-note]"
const COMPOSER = "div:has(> textarea[data-composer])"

function finished(name, colorScheme) {
  const { s } = base(name, { colorScheme, fix: !colorScheme, description: colorScheme ? "The numbers note in dark mode." : "A finished answer whose total and PKR figures are off: one quiet note, and Fix numbers sends the discrepancy." })
  s.assert = [
    { count: NOTE, equals: 1 },
    { text: "Some totals and conversions don't add up" },
    { text: "The Total row says $15,000 – $25,000, but the 4 rows above it add up to $19,500 – $38,000." },
    ...(colorScheme ? [{ count: `${NOTE} button`, equals: 0 }] : []),
    { box: NOTE, maxWidth: 720 },
  ]
  if (!colorScheme) {
    s.steps = [
      { assert: { visible: `${NOTE} button:text-is('Fix numbers')` } },
      { click: `${NOTE} button:text-is('Fix numbers')` },
      { assert: { requests: "POST /api/oc/session/*/prompt_async", body: "don't add up", equals: 1 } },
      { assert: { requests: "POST /api/oc/session/*/prompt_async", body: "add up to $19,500 – $38,000", equals: 1 } },
      { assert: { count: `${NOTE} button:text-is('Fix numbers')`, equals: 0 } },
    ]
  }
  return s
}

function streaming() {
  const { s, c, wrongMsg } = base("chat-numbers-streaming", { stream: true, fix: true, description: "The wrong answer streams in: no note while it streams or types out, then the note, in view above the composer." })
  const [reply] = openParts(s, c.id)
  const info = wrongMsg.info
  s.steps = [
    { emit: [partStart(reply), ...partDeltas(reply, WRONG, 40)], every: 30 },
    { assert: { count: NOTE, equals: 0 } },
    {
      emit: [
        partEnd(reply, { text: WRONG, at: NOW }),
        { type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: "stop" } } },
        { type: "session.idle", properties: { sessionID: c.id } },
      ],
    },
    { settle: true },
  ]
  s.assert = [
    { count: NOTE, equals: 1 },
    { inView: `${NOTE} button:text-is('Fix numbers')`, above: COMPOSER },
    { count: ".chat-log [data-revealing]", equals: 0 },
  ]
  return s
}

const variants = [finished("chat-numbers"), finished("chat-numbers-dark", "dark"), streaming()]

export default variants
