/**
 * syrup_calc on syrup's MCP server (registered in src/server/memory/tools.ts, so the local /mcp and the sandbox
 * sidecar serve the same tool). OpenCode prefixes it with the server's name: the model sees `syrup_calc`.
 * The description and schema ride on every request, so they stay short (scripts/test-numbers.mjs measures them).
 */
import { z } from "zod"
import { calc, type CalcResult, type RateTable } from "./core"
import { usdTable } from "./fx"

export const CALC_DESCRIPTION =
  "Exact calculator for totals, ranges, percentages and currency conversion; copy its results exactly. " +
  "One line each: name = expression. Ranges (15k..25k) add low to low, high to high. " +
  "Numbers take k, m, bn, lakh, crore and an ISO code (15k USD). " +
  "\"x in PKR\" converts at today's rate or at a line like \"1 USD = 278 PKR\"."

export const CALC_LINES_HELP = "e.g.\npermit = 15k..25k USD\ngear = 5k..10k USD\ntotal = permit + gear\ntotal_pkr = total in PKR"

export const calcInput = { lines: z.string().max(4000).describe(CALC_LINES_HELP) }

/** Runs the lines; fetches today's rates only when a conversion needs them and no rate line gave one. */
export async function runCalc(lines: string, getTable: () => Promise<RateTable | null> = usdTable): Promise<CalcResult> {
  const first = calc(lines)
  if (first.ok || first.code !== "rate-missing") return first
  return calc(lines, { table: await getTable() })
}

export type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean }

export async function calcTool({ lines }: { lines: string }): Promise<ToolText> {
  const r = await runCalc(lines)
  return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) }
}
