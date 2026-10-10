import { checks as c, defineCase } from "../../../eval/kit.mjs"

/** The pages give the foreigners' royalty and say nothing about Pakistani citizens: the answer must not invent a rule (K2 error c). */
const DENIES =
  /(pakistani|local|citizen|national)s?[^.\n]{0,60}\b(do not|don't|does not|doesn't|cannot|can't|are not|aren't|is not|isn't)\s+(get|receive|qualify|eligible|discounted|entitled)|\b(no|not)\s+(any\s+)?discount\w*[^.\n]{0,40}\b(for|to)\s+(pakistani|local|citizen|national)/i
const HEDGE =
  /not confirmed|(don't|do not|doesn't|does not|didn't|did not)\s+(mention|say|state|list|specify|cover|address)|no (information|mention)|(couldn't|could not|can't|cannot|wasn't able to|was not able to)\s+(find|confirm|verify)|(isn't|is not|aren't|are not)\s+(mentioned|stated|listed|covered)|not (mentioned|stated|listed|specified)/i

export default defineCase({
  id: "cite-not-confirmed",
  title: "A question no page answers (citation)",
  tags: ["citations", "research", "grounding"],
  cassette: "cassettes/cite-not-confirmed.json",
  turns: ["Do Pakistani citizens get a discount on the Nanga Parbat climbing royalty? Look it up and cite your source."],
  checks: [
    c.answered(),
    c.contains({ any: [HEDGE], column: "claims", name: "says no page confirms it" }),
    c.custom({
      name: "invents no rule",
      column: "claims",
      run: (t) => {
        const bad = t.live
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.text.split("\n"))
          .find((l) => DENIES.test(l) && !HEDGE.test(l))
        return { pass: !bad, detail: bad ? bad.trim().slice(0, 160) : "none" }
      },
    }),
    c.contains({ any: [/1,?800/], column: "numbers", name: "foreigners' fee", info: true }),
  ],
})
