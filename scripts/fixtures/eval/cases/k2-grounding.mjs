import { checks as c, defineCase } from "../../../eval/kit.mjs"
import { K2_GROUNDING } from "../../../eval/grounding-checks.mjs"

/**
 * The incident chat's grounding turn (docs/QUALITY.md §1, Q4): turns 1–5 of the real K2 export imported, then
 * "what about for a pakistani" runs live with the chat's own searches replayed and the operator pages those searches
 * found (fetched through syrup's webfetch). The real answer called $8,500–15,000 "local operator rates" and later
 * "full board", said permits aren't discounted for Pakistanis with no source, and gave one permit scheme of two.
 * Done when all four checks pass in ≥ 4 of 5 trials per routed model.
 */
export default defineCase({
  id: "k2-grounding",
  title: "K2 cost for a Pakistani climber (the incident's four grounding errors)",
  tags: ["citations", "research", "grounding"],
  seed: { transcript: "transcripts/k2.md", turns: 5 },
  cassette: "cassettes/k2-pkr.json",
  turns: ["what about for a pakistani"],
  checks: [
    c.answered(),
    ...K2_GROUNDING,
    c.noErrors(["cited-url"], { column: "urls", severities: ["error", "warn"], name: "links seen" }),
    // §7 decision 5: open the page before quoting a price. Recorded; the four checks are what must hold.
    c.usedTool("webfetch", { info: true }),
  ],
})
