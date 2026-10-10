/**
 * The chat's quiet "numbers don't add up" note under a finished answer (docs/QUALITY.md Q3), and the follow-up its
 * Fix numbers button sends. Pure: the chat loads it with the answer checks (src/lib/answer-checks) in one lazy chunk,
 * and scripts/test-numbers.mjs runs the same code on the labelled corpus to measure its precision.
 *
 * Only two kinds of finding make the note, both errors: a total that isn't the sum of its parts (table-total,
 * list-total), and a currency pair off by more than 1.5x (currency). Hints, warnings and the provenance, link and
 * context checks stay in `pnpm eval:check`.
 */
import { checkAnswer, REFERENCE_RATES, type Finding } from "./answer-checks"

/**
 * The Fix numbers button ships on only when the checker reaches ≥ 95% precision on a blind labelled set, measured
 * before anyone tunes the checker on it (docs/QUALITY.md Q3). Measured 2026-10-09: 90.3% on the first blind set and
 * 88.9% on the second, so it is OFF by default (scripts/test-numbers.mjs keeps this in line with BLIND there).
 * The flag that turns it on: NEXT_PUBLIC_SYRUP_FIX_NUMBERS=1 at build time, or localStorage "syrup.fix-numbers" =
 * "on" in one browser (the UI harness's chat-numbers scenario does that).
 */
export const FIX_NUMBERS_DEFAULT = false

export function fixNumbersEnabled(): boolean {
  if (FIX_NUMBERS_DEFAULT || process.env.NEXT_PUBLIC_SYRUP_FIX_NUMBERS === "1") return true
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("syrup.fix-numbers") === "on"
  } catch {
    return false
  }
}

const NOTE_CHECKS = new Set(["table-total", "list-total", "currency"])

/** The findings the note shows, at most three, in the order they appear. */
export function numberIssues(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const f of findings) {
    if (f.severity !== "error" || !NOTE_CHECKS.has(f.check) || seen.has(f.message)) continue
    seen.add(f.message)
    out.push(f)
  }
  return out.slice(0, 3)
}

/** Longer answers are not checked in the chat: the checks are linear, but a page's main thread is not the place to find out. */
export const MAX_CHECK_CHARS = 100_000

/** Every check the note needs, on one finished answer's text. */
export function checkNumbers(text: string): Finding[] {
  if (text.length > MAX_CHECK_CHARS || !/\d/.test(text)) return []
  // Backstop for the main thread: long runs of spaces or tabs carry no numbers, and are where regex backtracking hides.
  return numberIssues(checkAnswer(text.replace(/[^\S\n]{4,}/g, "   "), { referenceRates: REFERENCE_RATES }))
}

/** The note's one line: what is wrong, in the checker's own words. */
export function noteTitle(issues: Finding[]): string {
  const totals = issues.some((f) => f.check !== "currency")
  const fx = issues.some((f) => f.check === "currency")
  return totals && fx ? "Some totals and conversions don't add up" : totals ? (issues.length > 1 ? "Some totals don't match their parts" : "A total doesn't match its parts") : "A currency conversion looks off"
}

/** The user message the Fix numbers button sends: the exact discrepancies, and what to do about them. */
export function fixPrompt(issues: Finding[]): string {
  const lines = issues.map((f) => `- ${f.message}`)
  return [
    "Some numbers in your last answer don't add up:",
    ...lines,
    "Recompute them with syrup_calc (every part, the totals and any conversion, stating the rate) and send the corrected figures.",
  ].join("\n")
}
