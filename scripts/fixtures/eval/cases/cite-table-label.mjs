import { checks as c, defineCase } from "../../../eval/kit.mjs"
import { k2b } from "../../../eval/grounding-checks.mjs"

/**
 * The K2 label error in miniature: the search snippet says "from $8,500"; only the page's table says that is the
 * base-camp price for 6+ and full board is $28,000. The answer must open the page (§7 decision 5) and keep the label.
 */
export default defineCase({
  id: "cite-table-label",
  title: "A price whose label is only in the page's table (citation)",
  tags: ["citations", "research", "grounding"],
  cassette: "cassettes/cite-table-label.json",
  turns: ["How much is a full-board K2 expedition with Karakoram Base Treks for a group of 6 or more? Cite the page."],
  checks: [
    c.answered(),
    c.contains({ any: [/28,?000/], column: "numbers", name: "full board 6+" }),
    k2b,
    c.contains({ any: [/karakoram-base\.example\.org/], column: "urls", name: "cites the page" }),
    c.usedTool("webfetch", { column: "tools", name: "opened the page" }),
  ],
})
