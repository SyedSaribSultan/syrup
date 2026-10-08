/** mermaidFixes (docs/RENDERING.md §3.2a): each common break becomes the expected diagram; valid diagrams get no candidate. */
import { mermaidFixes, mermaidType } from "@/lib/rich/autofix"

type Check = (ok: boolean, label: string, detail?: string) => void

export default function run(check: Check) {
  const cases: [string, string, string][] = [
    ["parentheses inside a node's brackets get quotes", "flowchart LR\n    A[Cart (guest)] --> B[Checkout]", 'flowchart LR\n    A["Cart (guest)"] --> B[Checkout]'],
    ["a diamond holding brackets gets quotes", "graph TD\n    B{Empty [yes]?} --> C", 'graph TD\n    B{"Empty [yes]?"} --> C'],
    ["smart quotes become plain ones", "flowchart LR\n    A[“Start”] --> B", 'flowchart LR\n    A["Start"] --> B'],
    ["a stray fence line goes", "flowchart LR\n```mermaid\n    A --> B\n```", "flowchart LR\n    A --> B"],
    ["sequence: a message without its colon gets one, a trailing ; goes", "sequenceDiagram\n    A->>B hello there;\n    B-->>A: ok", "sequenceDiagram\n    A->>B: hello there\n    B-->>A: ok"],
    ["state: -> becomes -->", "stateDiagram-v2\n    [*] -> Idle\n    Idle -> Busy", "stateDiagram-v2\n    [*] --> Idle\n    Idle --> Busy"],
    ["pie: a slice gets its colon", 'pie title Pets\n    "Dogs" 386\n    "Cats" : 85', 'pie title Pets\n    "Dogs" : 386\n    "Cats" : 85'],
  ]
  for (const [label, broken, want] of cases) {
    const got = mermaidFixes(broken)
    check(got[0] === want, `mermaidFixes: ${label}`, JSON.stringify(got))
  }
  check(mermaidFixes("flowchart LR\n    A[Cart (guest)] --> B\n    C -- x --> D[“y”]").length <= 5, "at most 5 candidates")

  const valid = [
    "flowchart TD\n    A[Customer opens the cart] --> B{Cart empty?}\n    B -- Yes --> C[Show the empty state]\n    I --> J([Confirmation email])\n    K[(Database)] --> L[\"Quoted (fine)\"]",
    "sequenceDiagram\n    autonumber\n    participant B as Browser\n    B->>A: POST /api/checkout (cart id)\n    S-)A: Webhook payment_intent.succeeded",
    "stateDiagram-v2\n    [*] --> Idle\n    Idle --> [*]",
    'pie title Pets\n    "Dogs" : 386',
    "flowchart LR\n    A -->|Yes (b)| B",
  ]
  for (const v of valid) check(mermaidFixes(v).length === 0, `valid diagrams get no candidate: ${v.split("\n")[0]}…`, JSON.stringify(mermaidFixes(v)))
  // The arrow flowcharts don't have stays broken (chat-rich-broken shows it as source).
  check(mermaidFixes("flowchart LR\n    A -->> B").length === 0, "no fix for -->> in a flowchart")
  check(mermaidType("%% a comment\n\nflowchart LR\nA-->B") === "flowchart", "mermaidType skips comments and blank lines")
}
