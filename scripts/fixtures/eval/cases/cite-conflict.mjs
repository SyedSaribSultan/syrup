import { checks as c, defineCase } from "../../../eval/kit.mjs"

/** Two pages give different royalties for the same climb (an older club page, the newer official schedule): the answer must show both and say they differ. */
export default defineCase({
  id: "cite-conflict",
  title: "Two sources disagree on a fee (citation)",
  tags: ["citations", "research", "grounding"],
  cassette: "cassettes/cite-conflict.json",
  turns: ["What is the summer 2026 climbing royalty for Gasherbrum II per foreign climber? Look it up and cite your sources."],
  checks: [
    c.answered(),
    c.contains({ all: [/4,?600/, /4,?000/], column: "numbers", name: "both fees" }),
    // The substance of rule 4: both figures, each with its page, and the answer says they disagree or which is newer.
    c.contains({ any: [/sources differ/i, /\bdiffer/i, /\bconflict/i, /disagree/i, /\b(older|previously|newer|updated|outdated)\b/i], column: "claims", name: "says they differ" }),
    // The exact phrase the chat styles as a callout. Recorded, not required.
    c.contains({ any: [/sources differ\s*:/i], column: "claims", name: "Sources differ:", info: true }),
    c.contains({ all: [/gb-tourism\.example\.org/, /alpine-club\.example\.org/], column: "urls", name: "cites both" }),
  ],
})
