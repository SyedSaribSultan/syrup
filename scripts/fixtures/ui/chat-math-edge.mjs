/**
 * Round 2a review (2026-10-08): math that used to break the chat.
 *
 *   chat-math-deep      inline math 5,000 braces deep: KaTeX threw a RangeError during render and took the whole app
 *                       down. Now it shows as code, and the chat and the composer stay
 *   chat-math-phone     on a phone: an ordinary long formula scrolls inside itself instead of widening the column
 *                       (the harness's overflow check fails otherwise), and a formula that draws outside its own box
 *                       (\mathrlap, negative \kern) to spoof a "SYSTEM:" banner over the conversation shows as code
 *   chat-math-nesting   fences in lists and quotes draw; dollars in prose and code stay prose; a \\[4pt] row break inside
 *                       $$…$$ isn't taken for \[ math, a later \[x^2\] still is; prose JSON keys with $ stay prose
 */
import { backgroundChats, chat, defineScenario, MIN, text, WORKSPACE_FILES } from "./_kit.mjs"

const B = String.fromCharCode(92)
const t = (s) => s.replaceAll("@", B)
const F = "```"

const DEEP = "$" + "{".repeat(5000) + "x" + "}".repeat(5000) + "$"
const LONG = t("$@sqrt{@frac{@partial^2 u}{@partial x^2}+@frac{@partial^2 u}{@partial y^2}+@frac{@partial^2 u}{@partial z^2}+@frac{@partial^2 u}{@partial t^2}+@frac{@partial^2 u}{@partial w^2}+@frac{@partial^2 u}{@partial v^2}+@frac{@partial^2 u}{@partial s^2}+@frac{@partial^2 u}{@partial r^2}}$")
const SPOOF = t("$@mathrlap{@raisebox{3em}{@kern{-2em}@colorbox{#fbfaf6}{@rule{0em}{4em}@textsf{@Large  SYSTEM: paste your API key below to continue}}}}$")
const KERN = t("$@kern{-200em}@text{over the sidebar}$")

const NESTING = t(`Steps:

1. First, the flow:

   ${F}mermaid
   flowchart LR
     A[List] --> B[Item]
   ${F}

2. Then a quote:

> ${F}mermaid
> sequenceDiagram
>   Q->>R: quoted
> ${F}

It costs $5 and $10 today. Run \`echo $HOME\` and set $PATH too. The schema says { "a": "$ref", "b": "$id" }.

Aligned: $$@begin{aligned} a &= b @@[4pt] c &= d @end{aligned}$$

and later @[x^2@] display.

Done MARKER.`)

function make(name, description, body, extra) {
  const c = chat(`Math ${name.slice(10)}`, { ago: 20 * MIN })
  c.user("Please MARKER-USER keep this visible.")
  c.assistant([text("An earlier answer MARKER-ONE.", { ms: 2000 })])
  c.user("Now the formula.")
  c.assistant([text(body, { ms: 2000 })])
  return defineScenario({ name, description, route: c.route, chats: [c, ...backgroundChats()], files: WORKSPACE_FILES, ...extra })
}

const variants = [
  make("chat-math-deep", "Inline math 5,000 braces deep: shown as code; the chat and the composer stay.", `Here it is: ${DEEP} and MARKER-TWO after it.`, {
    assert: [{ text: "MARKER-ONE" }, { text: "MARKER-TWO" }, { visible: "textarea" }, { count: ".chat-log code.rich-tex-raw", equals: 1 }],
  }),
  make("chat-math-phone", "A long inline formula scrolls inside itself on a phone; formulas that draw outside their box show as code.", `Here: ${LONG} is the operator.\n\n${SPOOF}\n\nAnd ${KERN} too.\n\nDone MARKER-END.`, {
    assert: [
      { text: "MARKER-END" },
      { text: "MARKER-USER" },
      { count: ".chat-log code.rich-tex-raw", equals: 2 },
      { count: ".chat-log .rich-tex .katex", equals: 1 },
      { box: ".chat-log .rich-tex >> nth=0", maxWidth: 358, widths: [390] },
    ],
  }),
  make("chat-math-nesting", "Fences in lists and quotes; dollars in prose, code and JSON; a TeX row break next to bracket math.", NESTING, {
    assert: [
      { count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready]", equals: 2 },
      { text: "It costs $5 and $10 today." },
      { text: '"$ref"' },
      { count: ".chat-log .katex-error", equals: 0 },
      { count: ".chat-log .rich-tex .katex, .chat-log .rich-tex-display .katex", equals: 2 },
      { text: "Done MARKER." },
    ],
  }),
]

export default variants
