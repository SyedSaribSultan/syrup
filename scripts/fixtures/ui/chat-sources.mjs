/**
 * Q4 (docs/QUALITY.md §Q4): sources under a finished web answer, and images from other sites that wait for a tap
 * (docs/ROADMAP.md §7).
 *
 *   chat-sources            a finished research answer: numbered chips after links to the two pages it read (not after
 *                           the link to a page it never read), a card with the matching passage, "Sources differ:" and
 *                           "Not confirmed:" callouts, a "Read 3 pages" footer. Images from other sites (inline,
 *                           reference-style) are buttons; the data: and same-origin ones show; HTML <img> and an
 *                           autolink stay text and a link. Zero requests to other origins until "Load image" is tapped,
 *                           then exactly one. The flag is on (localStorage "syrup.source-flags"): the chip whose line
 *                           gives $29,900, which its page doesn't, carries it.
 *   chat-sources-dark       the same in dark mode, with the flag at its default (off): no flagged chip
 *   chat-sources-streaming  the answer streams in front of the user: no chip, callout or footer while it streams or
 *                           types out, then all of them
 *   chat-sources-export     the chat exported as HTML, opened with JavaScript on and off: the image buttons are there and
 *                           nothing is fetched from another origin
 *
 * The page text holds a planted <img onerror> and a <script>: they reach the card as text only.
 */
import { backgroundChats, chat, defineScenario, NOW, openParts, partDeltas, partEnd, partStart, SEC, text, tool, WORKSPACE_FILES } from "./_kit.mjs"
import { EXPORT_STEPS } from "./chat-rich-export.mjs"

const TOURS = "https://tours.example.net/k2/"
const PERMITS = "https://permits.example.net/royalty-2026"

const PAGE = `Source: ${TOURS}
Title: K2 Expedition 2026 | Example Tours
Fetched: 2026-10-07
---

# K2 Expedition prices

<img src=x onerror="document.body.insertAdjacentText('beforeend','PWNED')"> <script>document.body.insertAdjacentText('beforeend','PWNED')</script>

| Group size | Base camp service | Full board |
| --- | --- | --- |
| 1-2 members | $15,000 | $30,000 |
| 6+ members | $8,500 | $28,000 |`

const SEARCH = `Title: Royalty schedule 2026
URL: ${PERMITS}
Published: 2026-01-15
Highlights:
Royalty for K2 in summer: USD 5,000 per person.

---

Title: K2 permits explained
URL: https://guide.example.net/k2-permit
Published: 2025-05-01
Highlights:
A team of seven pays USD 9,500, plus USD 3,000 for each extra member.`

export const ANSWER = `Base-camp packages start at $8,500 for groups of 6+, while full board is $28,000 ([Example Tours](${TOURS})).

- **Base camp, 1–2 members:** $15,000 ([Example Tours](${TOURS})).
- **Full board, 1–2 members:** $29,900 ([Example Tours](${TOURS})).
- **Permit:** USD 5,000 per person ([Royalty schedule](${PERMITS})).

Sources differ: [Royalty schedule](${PERMITS}) says USD 5,000 per person; [K2 permits explained](https://guide.example.net/k2-permit) says USD 9,500 per team.

Not confirmed: whether Pakistani nationals pay a different royalty. See also [Wikipedia](https://en.wikipedia.org/wiki/K2).

![Route map](https://images.example.org/k2-route.png)

![Base camp][bc]

[bc]: https://cdn.example.org/base-camp.jpg

<img src="https://tracker.example.org/pixel.gif">

<https://images.example.org/raw.png>

![dot](data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==) ![icon](/favicon.ico)`

function base(name, opts = {}) {
  const c = chat("K2 cost, with sources", { ago: 0 })
  c.user("What does a K2 expedition cost? Cite your sources.")
  c.assistant([tool("websearch", { query: "k2 permit royalty 2026" }, { output: SEARCH }), tool("webfetch", { url: TOURS, format: "markdown" }, { output: PAGE })])
  c.assistant([text(opts.answer ?? ANSWER, opts.stream ? { open: true, later: true, ms: 3 * SEC } : {})], opts.stream ? { open: true } : {})
  const s = defineScenario({
    name,
    description: opts.description,
    route: c.route,
    chats: [c, ...backgroundChats()],
    files: WORKSPACE_FILES,
    ...(opts.colorScheme && { colorScheme: opts.colorScheme }),
    ...(opts.flags && { storage: { "syrup.source-flags": "on" } }),
    ...(opts.expectConsole && { expectConsole: opts.expectConsole }),
  })
  // The answer gives an amount its page doesn't ($29,900) and links pages nobody read, on purpose: scripts/test-eval-checks.mjs
  // leaves this chat out of its false-alarm count.
  s.plantedSources = true
  return { s, c }
}

const CHIP = ".chat-log [data-source-chip]"
const CARD = "[data-source-card]"

/** What a finished, grounded answer shows (the flag aside). */
const SHOWN = [
  { count: CHIP, equals: 6 },
  { count: ".chat-log [data-source='1'] [data-source-chip]", equals: 3 },
  { count: ".chat-log [data-source='2'] [data-source-chip]", equals: 2 },
  { count: ".chat-log a[href='https://en.wikipedia.org/wiki/K2']", equals: 1 },
  { count: ".chat-log [data-source] a[href='https://en.wikipedia.org/wiki/K2']", equals: 0 },
  { count: ".chat-log [data-callout=differ]", equals: 1 },
  { count: ".chat-log [data-callout=unconfirmed]", equals: 1 },
  { visible: ".chat-log [data-read-pages] summary:has-text('Read 3 pages')" },
  { count: ".chat-log button[data-external-image]", equals: 2 },
  { visible: ".chat-log button[data-external-image='images.example.org']" },
  { visible: ".chat-log button[data-external-image='cdn.example.org']" },
  { count: ".chat-log img[src^='https://']", equals: 0 },
  { count: ".chat-log img[src^='data:image/gif']", equals: 1 },
  { count: ".chat-log img[src='/favicon.ico']", equals: 1 },
  { visible: ".chat-log :text('<img src=\"https://tracker.example.org/pixel.gif\">')" },
  { count: ".chat-log a[href='https://images.example.org/raw.png']", equals: 1 },
  { hidden: "text=PWNED" },
  { external: 0 },
]

function finished(name, colorScheme) {
  const { s } = base(name, {
    colorScheme,
    flags: !colorScheme,
    // The tapped image is fetched from another origin, which the harness blocks.
    expectConsole: [{ match: /ERR_BLOCKED_BY_CLIENT/, why: "the image the test taps to load is on another origin, blocked by the harness" }],
    description: colorScheme
      ? "Sources in dark mode, the flag at its default (off)."
      : "Chips, a card, callouts, the Read N pages footer; other sites' images wait for a tap: zero external requests until then.",
  })
  s.steps = [
    { assert: { external: 0 } },
    { click: `${CHIP} >> nth=0` },
    { assert: { visible: CARD } },
    { assert: { visible: `${CARD} mark:text-is('8,500')` } },
    { assert: { visible: `${CARD} a:text-is('Open page')` } },
    { assert: { box: CARD, maxWidth: 360 } },
    { press: "Escape" },
    { assert: { hidden: CARD } },
    { click: ".chat-log [data-read-pages] summary" },
    { assert: { visible: ".chat-log [data-read-pages] li:has-text('Royalty schedule 2026')" } },
    { assert: { external: 0 } },
    { click: ".chat-log button[data-external-image='images.example.org']" },
    { assert: { count: ".chat-log img[src='https://images.example.org/k2-route.png']", equals: 1 } },
    { assert: { external: 1 } },
  ]
  s.assert = [
    // After the tap: one image from another site, one button left.
    ...SHOWN.filter(
      (a) =>
        !("external" in a) &&
        a.count !== ".chat-log img[src^='https://']" &&
        a.count !== ".chat-log button[data-external-image]" &&
        a.visible !== ".chat-log button[data-external-image='images.example.org']",
    ),
    { count: ".chat-log button[data-external-image]", equals: 1 },
    { count: ".chat-log [data-source-chip][data-flagged]", equals: colorScheme ? 0 : 1 },
    { hidden: "text=PWNED" },
  ]
  return s
}

function streaming() {
  const { s, c } = base("chat-sources-streaming", { stream: true, description: "The answer streams in: no chip, callout or footer while it streams or types out; then all of them." })
  const [reply] = openParts(s, c.id)
  const info = s.engine.messages[c.id].at(-1).info
  s.steps = [
    { emit: [partStart(reply), ...partDeltas(reply, ANSWER, 60)], every: 30 },
    { assert: { count: CHIP, equals: 0 } },
    { assert: { count: ".chat-log [data-callout]", equals: 0 } },
    { assert: { count: ".chat-log [data-read-pages]", equals: 0 } },
    {
      emit: [
        partEnd(reply, { text: ANSWER, at: NOW }),
        { type: "message.updated", properties: { sessionID: c.id, info: { ...info, time: { ...info.time, completed: NOW + SEC }, finish: "stop" } } },
        { type: "session.idle", properties: { sessionID: c.id } },
      ],
    },
    { settle: true },
  ]
  s.assert = [...SHOWN, { count: ".chat-log [data-revealing]", equals: 0 }]
  return s
}

function exported() {
  const { s } = base("chat-sources-export", {
    // A root-relative image has no site to resolve against in a file (it would ask for file:///favicon.ico): left out here.
    answer: ANSWER.replace(" ![icon](/favicon.ico)", ""),
    description: "The chat exported as HTML, opened with JavaScript on and off: image buttons, nothing fetched from another origin." })
  const FILE = [{ external: 0 }, { count: "button[data-external-image]", equals: 2 }, { count: "img[src^='https://']", equals: 0 }, { hidden: "text=PWNED" }]
  s.steps = [...EXPORT_STEPS, { openFile: "export.html", javaScript: true }, ...FILE.map((a) => ({ assert: a })), { openFile: "export.html", javaScript: false }]
  s.assert = [{ file: "export.html", notContains: ['https://images.example.org/k2-route.png"', "<script"] }, ...FILE]
  return s
}

const variants = [finished("chat-sources"), finished("chat-sources-dark", "dark"), streaming(), exported()]

export default variants
