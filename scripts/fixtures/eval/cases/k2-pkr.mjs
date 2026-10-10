import { checks as c, defineCase } from "../../../eval/kit.mjs"

/**
 * The incident chat (docs/QUALITY.md §1): turns 1–6 of the real K2 export are imported as they
 * happened, then "in PKR" runs live with the chat's own search results replayed. The real answer
 * put every PKR figure 10× too high and stated totals that weren't the sum of their parts.
 */
export default defineCase({
  id: "k2-pkr",
  title: "K2 budget converted to PKR (the incident chat, last turn)",
  tags: ["smoke", "numbers", "research"],
  seed: { transcript: "transcripts/k2.md", turns: 6 },
  cassette: "cassettes/k2-pkr.json",
  turns: ["in PKR"],
  checks: [
    c.answered(),
    // `pnpm eval:check` finds no error in the live turn: PKR equals USD at the rate the answer states…
    c.noErrors(["currency"], { column: "numbers" }),
    // …and every total equals the sum of its parts. Blocking since Q3 (syrup_calc and the prompt's Numbers rule).
    c.noErrors(["table-total", "list-total"], { column: "sums" }),
    // Recorded: did the model use the calculator? (QUALITY.md §6: weak models skip tools; the checks are the backstop.)
    c.usedTool("syrup_calc", { info: true }),
    c.noErrors(["provenance"], { column: "prov", severities: ["error", "warn"], info: true }),
    c.noErrors(["cited-url"], { column: "urls", severities: ["error", "warn"] }),
    c.judged({ claim: "permits are or aren't discounted for Pakistanis", info: true }),
    // §7 decision 1. Met by Q2 (the plugin masks earlier turns' web results): 55k → 11.4k on 2026-10-08.
    c.lastTurnInputTokens({ max: 15_000 }),
  ],
})
