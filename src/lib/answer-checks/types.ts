/**
 * Shared shapes for the answer checks. Everything in this folder is pure TypeScript with no
 * imports from outside it, so the chat UI, `pnpm eval:check` and the Tier 0 gate run the same code.
 */

export type Severity = "error" | "warn" | "hint"

export type CheckId =
  /** A Markdown table's Total row doesn't equal the rows above it. */
  | "table-total"
  /** A list of priced items doesn't add up to the total stated before or after it. */
  | "list-total"
  /** A pair of amounts in two currencies doesn't match the rate (10x lakh/crore slips). */
  | "currency"
  /** A number the answer gives was not found in anything the agent read. */
  | "provenance"
  /** A number sits next to a qualifier ("full board") that never appears near it in the sources. */
  | "label"
  /** A blanket claim ("not discounted") whose key word appears in no page the agent read. */
  | "claim"
  /** A link in the answer points at a page the agent never saw. */
  | "cited-url"
  /** The request behind the answer was larger than the context budget. */
  | "context"
  /** The answer ended in an error or never finished. */
  | "finished"

export type Finding = {
  check: CheckId
  severity: Severity
  /** One plain sentence a person can act on. */
  message: string
  /** What the finding is about: always the excerpt it came from, plus check-specific numbers. */
  evidence: { excerpt: string } & Record<string, unknown>
}

/** Exchange rates as "how many units of the quote currency per one unit of the base": { USD: { PKR: 277 } }. */
export type Rates = Record<string, Record<string, number>>

/** Something the agent read: a search result, a fetched page, any tool output, or text the user gave. */
export type Source = {
  /** The page's URL when there is one (search results, webfetch). */
  url?: string
  /** "websearch", "webfetch", "read", "user", "earlier-answer"… */
  kind: string
  text: string
}
