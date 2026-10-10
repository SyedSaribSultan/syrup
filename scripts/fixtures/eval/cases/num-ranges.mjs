import { checks as c, defineCase } from "../../../eval/kit.mjs"

/**
 * Q3's numeric set: a range total is the sum of the lows to the sum of the highs.
 * 8k + 6.5k + 2k + 1.2k + 900 = $18,600; 12k + 9k + 3.5k + 2.8k + 1.5k = $28,800.
 */
export default defineCase({
  id: "num-ranges",
  title: "A budget of five ranges and its total range (numbers)",
  tags: ["numeric", "numbers"],
  turns: [
    "Our wedding quotes: venue $8k–12k, catering $6.5k–9k, photographer $2k–3.5k, dress $1.2k–2.8k, flowers $900–1.5k. List them and give the total range.",
  ],
  checks: [
    c.answered(),
    c.amount({ cur: "USD", lo: 18_600, hi: 28_800 }),
    c.noErrors(["table-total", "list-total"], { column: "sums" }),
    c.usedTool("syrup_calc", { info: true }),
  ],
})
