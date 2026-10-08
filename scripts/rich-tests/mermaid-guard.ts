/**
 * The Mermaid pre-flight (src/lib/rich/mermaid-guard.ts): sources that would fetch while Mermaid lays them out are
 * named, CSS escapes included; ordinary diagrams pass; the chat's size cap counts links.
 */
import { cssUnescape, mermaidFetchRisk, mermaidSize, mermaidTooLargeForChat, MERMAID_CHAT_MAX_LINKS } from "@/lib/rich/mermaid-guard"
import { RICH_ANSWER } from "../fixtures/ui/chat-rich-fences.mjs"

type Check = (ok: boolean, label: string, detail?: string) => void

const B = String.fromCharCode(92)

export default function run(check: Check) {
  check(cssUnescape(`${B}75rl(`) === "url(" && cssUnescape(`${B}000075 rl(`) === "url(" && cssUnescape(`u${B}rl(`) === "url(", "cssUnescape decodes hex and plain escapes")
  const risky: [string, string][] = [
    ["img shape", 'flowchart LR\n  A@{ img: "https://e.com/x.png", label: "x" }'],
    ["img shape, quoted key", 'flowchart LR\n  A@{ "img": "https://e.com/x.png" }'],
    ["url() in a classDef", "stateDiagram-v2\n  classDef bad border-image:url(https://e.com/b.png) 30"],
    ["URL() in capitals", "flowchart LR\n  style A mask-image:URL(https://e.com/m.png)"],
    ["a hex-escaped url(", `flowchart LR\n  classDef x mask-image:${B}75rl(https://e.com/m.png)`],
    ["a plainly escaped url(", `flowchart LR\n  classDef x mask-image:u${B}rl(https://e.com/m.png)`],
    ["image-set()", 'flowchart LR\n  style A border-image:image-set("https://e.com/i.png" 1x) 30'],
    ["src()", "flowchart LR\n  style A mask-image:src(https://e.com/s.png)"],
    ["@import", "flowchart LR\n  classDef x fill:red;}@import url(https://e.com/i.css);x{fill:red"],
  ]
  for (const [label, src] of risky) check(mermaidFetchRisk(src) !== null, `refused: ${label}`)
  const fine = ["flowchart TD\n  A[Customer opens the cart] --> B{Cart empty?}", "sequenceDiagram\n  B->>A: POST /api/checkout (cart id)", 'pie title Pets\n  "Dogs" : 386', 'flowchart LR\n  A["C:\\\\Users\\\\me"] --> B', String(RICH_ANSWER)]
  for (const src of fine) check(mermaidFetchRisk(src) === null, `ordinary source passes: ${src.split("\n")[0].slice(0, 40)}`, String(mermaidFetchRisk(src)))

  const big = "flowchart TD\n" + Array.from({ length: MERMAID_CHAT_MAX_LINKS + 1 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n")
  check(mermaidSize(big).links === MERMAID_CHAT_MAX_LINKS + 1, "mermaidSize counts links", JSON.stringify(mermaidSize(big)))
  check(mermaidTooLargeForChat(big), `over ${MERMAID_CHAT_MAX_LINKS} links is too large for the chat`)
  check(!mermaidTooLargeForChat("flowchart TD\n" + Array.from({ length: 40 }, (_, i) => `  n${i} -.-> n${i + 1}`).join("\n")), "40 links draw in the chat")
  check(mermaidSize("sequenceDiagram\n  A->>B: hi\n  B-->>A: ok\n  A-xB: lost").links === 3, "sequence arrows count as links")
}
