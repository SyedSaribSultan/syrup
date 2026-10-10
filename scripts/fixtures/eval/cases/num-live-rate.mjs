import { checks as c, defineCase } from "../../../eval/kit.mjs"

/**
 * Q3's numeric set: conversion at today's rate (syrup_calc's rate table, fetched live). At ~277 PKR per USD and
 * ~310 per EUR (2026-10-08), $2,500 + €1,800 ≈ PKR 12.5 lakh; 5% covers normal drift, not a 10x slip.
 */
export default defineCase({
  id: "num-live-rate",
  title: "Two currencies to PKR at today's rate, in lakh (numbers)",
  tags: ["numeric", "numbers"],
  turns: ["Convert $2,500 and €1,800 to Pakistani rupees at today's rate and give me the total in lakh."],
  checks: [
    c.answered(),
    c.amount({ cur: "PKR", value: 1_255_000, tol: 0.05 }),
    c.noErrors(["currency"], { column: "numbers", name: "currency" }),
    c.noErrors(["table-total", "list-total"], { column: "sums" }),
    c.usedTool("syrup_calc", { info: true }),
  ],
})
