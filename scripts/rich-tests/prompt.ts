/**
 * The prompt's "# What the chat can show" (docs/RENDERING.md §3.0): it rides on every request, so it stays under about
 * 250 tokens (characters ÷ 4), and it names what Round 2a draws.
 */
import { SYRUP_PROMPT } from "@/server/engine/prompt"

type Check = (ok: boolean, label: string, detail?: string) => void

export default function run(check: Check) {
  const start = SYRUP_PROMPT.indexOf("# What the chat can show")
  check(start >= 0, "SYRUP_PROMPT has # What the chat can show")
  const rest = SYRUP_PROMPT.slice(start)
  const next = rest.indexOf("\n# ", 1)
  const section = next < 0 ? rest : rest.slice(0, next)
  const tokens = Math.ceil(section.length / 4)
  check(tokens <= 250, `the section is ≤ 250 tokens (${tokens})`)
  check(SYRUP_PROMPT.indexOf("# How you talk") < start && SYRUP_PROMPT.indexOf("# How you work") > start, "it sits right after # How you talk")
  for (const word of ["```mermaid", "```svg", "$…$", "$$…$$"]) check(section.includes(word), `it names ${word}`)
}
