import { checks as c, defineCase } from "../../../eval/kit.mjs"

/**
 * A cost table with a total, from hand-written price pages (synthetic cassette). The pages fix
 * the right total: 4 × 18,000 + 3 × 22,000 + 2 × 46,000 + 2 × 5 × 4,500 = PKR 275,000.
 */
export default defineCase({
  id: "budget-table",
  title: "Hunza trip budget table with a total (numbers)",
  tags: ["smoke", "numbers", "research"],
  cassette: "cassettes/budget-table.json",
  turns: [
    "Make a table of what a 5-day trip to Hunza costs for two people: 4 nights in a mid-range hotel (one double room), a car with driver for 3 days, return flights from Islamabad for both of us, and food for both of us for all 5 days. Look up current prices on the web, give every amount in PKR, and end the table with a Total row.",
  ],
  checks: [
    c.answered(),
    c.hasTotalRow(),
    c.noErrors(["table-total", "list-total"], { column: "sums" }),
    c.contains({ any: [/\b2,75,000\b/, /\b275,000\b/, /\b275k\b/i, /\b2\.75 lakh\b/i], column: "numbers", name: "total 275,000" }),
    c.noErrors(["currency"], { column: "numbers", name: "currency" }),
    c.noErrors(["provenance"], { column: "prov", severities: ["error", "warn"], info: true }),
    c.noErrors(["cited-url"], { column: "urls", severities: ["error", "warn"] }),
  ],
})
