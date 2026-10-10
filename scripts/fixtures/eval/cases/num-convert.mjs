import { checks as c, defineCase } from "../../../eval/kit.mjs"

/**
 * Q3's numeric set: a sum, then a conversion at a rate the user gives. (3,450 + 1,280) × 280 = PKR 13,24,400.
 */
export default defineCase({
  id: "num-convert",
  title: "Two prices summed and converted at the user's rate (numbers)",
  tags: ["numeric", "numbers"],
  turns: ["I'm quoted $3,450 for a laptop and $1,280 for a monitor. At 280 PKR to the dollar, what do both cost together in PKR?"],
  checks: [
    c.answered(),
    c.amount({ cur: "PKR", value: 1_324_400 }),
    c.noErrors(["currency"], { column: "numbers", name: "currency" }),
    c.noErrors(["table-total", "list-total"], { column: "sums" }),
    c.usedTool("syrup_calc", { info: true }),
  ],
})
