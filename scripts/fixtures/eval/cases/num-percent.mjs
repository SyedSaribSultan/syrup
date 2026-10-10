import { checks as c, defineCase } from "../../../eval/kit.mjs"

/**
 * Q3's numeric set: percentages in order. 49 × 23 seats × 12 months = $13,524; 15% off = $11,495.40;
 * 8.5% tax on that = $12,472.51.
 */
export default defineCase({
  id: "num-percent",
  title: "Seats, a discount, then tax (numbers)",
  tags: ["numeric", "numbers"],
  turns: [
    "A SaaS plan is $49 per seat per month. We have 23 seats and get 15% off for paying annually; 8.5% sales tax applies to the discounted price. What's the annual total?",
  ],
  checks: [c.answered(), c.amount({ cur: "USD", value: 12_472.51 }), c.noErrors(["table-total", "list-total"], { column: "sums" }), c.usedTool("syrup_calc", { info: true })],
})
