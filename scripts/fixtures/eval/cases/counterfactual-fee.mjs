import { checks as c, defineCase } from "../../../eval/kit.mjs"

/**
 * Grounding over memory: the only page the agent can read states a deliberately unusual fee
 * (USD 1,370) for Spantik. The answer must give that number and point at that page.
 */
export default defineCase({
  id: "counterfactual-fee",
  title: "Permit fee the agent must read, not remember (citation)",
  tags: ["smoke", "citations", "research"],
  cassette: "cassettes/counterfactual-fee.json",
  turns: ["What is the 2026 climbing permit fee (royalty) for Spantik in Pakistan for a foreign climber? Look it up and cite your source."],
  checks: [
    c.answered(),
    c.contains({ any: [/\b1,370\b/, /\b1370\b/], column: "numbers", name: "uses the fee it read" }),
    c.contains({ any: [/permits\.example\.org/], column: "urls", name: "cites the page" }),
    c.noErrors(["cited-url"], { column: "urls", severities: ["error", "warn"], name: "links seen" }),
    c.noErrors(["provenance"], { column: "prov", severities: ["error", "warn"], info: true }),
  ],
})
