import { checks as c, defineCase } from "../../../eval/kit.mjs"

/**
 * Q3's numeric set: lakh and crore. PKR 3.75 lakh a month is 45 lakh a year; +12% in years 2 and 3 gives 50.4 and
 * 56.448 lakh: 151.848 lakh in all, PKR 1,51,84,800 (1.52 crore).
 */
export default defineCase({
  id: "num-lakh-crore",
  title: "Three years of a salary in lakh and crore (numbers)",
  tags: ["numeric", "numbers"],
  turns: [
    "My salary is PKR 3.75 lakh a month. I get a 12% raise at the start of year 2 and again at the start of year 3. How much do I earn over the 3 years in total? Give it in lakh and crore.",
  ],
  checks: [c.answered(), c.amount({ cur: "PKR", value: 15_184_800, tol: 0.006 }), c.noErrors(["table-total", "list-total"], { column: "sums" }), c.usedTool("syrup_calc", { info: true })],
})
