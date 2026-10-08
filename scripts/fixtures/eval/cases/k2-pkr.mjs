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
    // …and every total equals the sum of its parts. Recorded, not yet blocking: without a calculator the model's totals
    // miss their own parts most of the time (2026-10-08: 1 of 1, then 0 of 3), so neither "pass" nor "known gap" holds.
    // Q3 (syrup_calc + the Numbers rule) makes it blocking: drop `info` in that change.
    c.noErrors(["table-total", "list-total"], { column: "sums", info: true }),
    c.noErrors(["provenance"], { column: "prov", severities: ["error", "warn"], info: true }),
    c.noErrors(["cited-url"], { column: "urls", severities: ["error", "warn"] }),
    c.judged({ claim: "permits are or aren't discounted for Pakistanis", info: true }),
    c.lastTurnInputTokens({
      max: 15_000,
      gap: "Q2 (context hygiene): the seeded chat carries ~55k tokens (mostly raw search output) into the last turn. The 15k budget (§7 decision 1) is met only once the plugin trims and masks old web results; delete this note in that change.",
    }),
  ],
})
