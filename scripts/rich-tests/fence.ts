/**
 * The fence closure rule (docs/RENDERING.md §2.4, §3.2a acceptance): the spike's twelve cases, `$$` blocks,
 * trimPartialCloser, fenceKind, fileKind, and every prefix of chat-rich-fences's reply rendered as the chat renders it:
 * a fence never goes from closed back to open, and its kind resolves only after the info line's newline.
 */
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { fenceState, trimPartialCloser } from "@/lib/rich/fence"
import { fenceKind, fileKind, toolKind } from "@/lib/rich/kinds"
import { RICH_ANSWER } from "../fixtures/ui/chat-rich-fences.mjs"

type Check = (ok: boolean, label: string, detail?: string) => void

const T = "```"

export default function run(check: Check) {
  const cases: [string, string, { closed: boolean; infoDone: boolean; marker?: string; run?: number }][] = [
    ["opener only", `${T}mer`, { closed: false, infoDone: false }],
    ["opener and newline", `${T}mermaid\n`, { closed: false, infoDone: true }],
    ["partial closer", `${T}mermaid\nA-->B\n${"``"}`, { closed: false, infoDone: true }],
    ["closed", `${T}mermaid\nA-->B\n${T}`, { closed: true, infoDone: true }],
    ["closer with trailing spaces", `${T}mermaid\nA-->B\n${T}   `, { closed: true, infoDone: true }],
    ["tilde fence closed by backticks stays open", `~~~svg\n<svg/>\n${T}`, { closed: false, infoDone: true, marker: "~" }],
    ["tilde fence closed by tildes", `~~~svg\n<svg/>\n~~~`, { closed: true, infoDone: true, marker: "~" }],
    ["4-backtick opener, 3-backtick line stays open", "````md\nx\n```", { closed: false, infoDone: true, run: 4 }],
    ["4-backtick opener closed by 4", "````md\nx\n````", { closed: true, infoDone: true, run: 4 }],
    ["fence in a list", `  ${T}mermaid\n  A-->B\n  ${T}`, { closed: true, infoDone: true }],
    ["fence in a quote", `> ${T}mermaid\n> A-->B\n> ${T}`, { closed: true, infoDone: true }],
    ["no final newline before the closer arrives", `${T}mermaid\nA-->B`, { closed: false, infoDone: true }],
    ["longer closer", `${T}mermaid\nA-->B\n${"`````"}`, { closed: true, infoDone: true }],
    ["closer with the final newline", `${T}mermaid\nA-->B\n${T}\n`, { closed: true, infoDone: true }],
    ["a line with an info string is not a closer", `${T}md\n${T}python\nx`, { closed: false, infoDone: true }],
    ["$$ open", "$$\nx^2", { closed: false, infoDone: true, marker: "$", run: 2 }],
    ["$$ partial closer", "$$\nx^2\n$", { closed: false, infoDone: true, marker: "$" }],
    ["$$ closed", "$$\nx^2\n$$", { closed: true, infoDone: true, marker: "$", run: 2 }],
  ]
  for (const [label, raw, want] of cases) {
    const s = fenceState(raw)
    const ok = s.closed === want.closed && s.infoDone === want.infoDone && (want.marker === undefined || s.marker === want.marker) && (want.run === undefined || s.run === want.run)
    check(ok, `fenceState: ${label}`, JSON.stringify(s))
  }

  check(trimPartialCloser("A-->B\n``\n", "`") === "A-->B\n", "trimPartialCloser drops a last line of two backticks")
  check(trimPartialCloser("A-->B\n`", "`") === "A-->B\n", "trimPartialCloser drops a last line of one backtick")
  check(trimPartialCloser("x^2\n$", "$") === "x^2\n", "trimPartialCloser drops a lone $")
  check(trimPartialCloser("A-->B\nC", "`") === "A-->B\nC", "trimPartialCloser keeps real content")
  check(trimPartialCloser("a\n~~", "~") === "a\n", "trimPartialCloser drops a partial tilde closer")

  check(fenceKind("mermaid") === "mermaid" && fenceKind("Mermaid ") === "mermaid", "fenceKind: mermaid, any case")
  check(fenceKind("svg") === "svg", "fenceKind: svg")
  check(fenceKind("xml", '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>') === "svg" && fenceKind("xml") === null && fenceKind("xml", "<note/>") === null, "fenceKind: xml is svg only by its body, once known")
  check(fenceKind("vega-lite") === "vega-lite" && fenceKind("csv") === "table" && fenceKind("markmap") === "markmap", "fenceKind: Round 3's kinds are known (drawn once enabled)")
  check(fenceKind("python") === null && fenceKind("") === null && fenceKind("ts") === null, "fenceKind: code languages are not rich")
  check(fileKind("docs/flow.mmd") === "mermaid" && fileKind("a/b/chart.vl.json") === "vega-lite" && fileKind("data.json") === null, "fileKind: full-name suffixes first")
  check(fileKind("Logo.SVG") === "svg" && fileKind("plan.mm.md") === "markmap" && fileKind("README.md") === null, "fileKind: extensions, any case")
  check(toolKind("syrup_show_chart") === "vega-lite" && toolKind("syrup_ask_form") === "form" && toolKind("bash") === null, "toolKind")

  // Every prefix of the acceptance reply, through the chat's own Markdown parse.
  const answer = String(RICH_ANSWER)
  let seen: { closed: boolean; kind: string | null }[] = []
  const problems: string[] = []
  const at = (n: number) => answer.slice(0, n)
  for (let n = 1; n <= answer.length; n++) {
    const src = at(n)
    const fences: { closed: boolean; kind: string | null; infoDone: boolean }[] = []
    const components: Components = {
      pre: ({ node, children }) => {
        const p = node?.position
        if (p?.start.offset != null && p.end.offset != null) {
          const st = fenceState(src.slice(p.start.offset, p.end.offset))
          const code = (node?.children?.[0] as { properties?: { className?: string[] } } | undefined)?.properties?.className ?? []
          const lang = code.find((c) => String(c).startsWith("language-"))?.slice(9) ?? ""
          fences.push({ closed: st.closed, infoDone: st.infoDone, kind: st.infoDone && lang ? fenceKind(lang) : null })
        }
        return createElement("pre", null, children as ReactNode)
      },
    }
    renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, src))
    fences.forEach((f, i) => {
      const before = seen[i]
      if (before?.closed && !f.closed) problems.push(`prefix ${n}: fence ${i + 1} went from closed back to open`)
      if (!f.infoDone && f.kind) problems.push(`prefix ${n}: fence ${i + 1} has a kind before its info line ended`)
      if (before?.kind && f.kind && before.kind !== f.kind) problems.push(`prefix ${n}: fence ${i + 1} changed kind from ${before.kind} to ${f.kind}`)
    })
    seen = fences.map((f) => ({ closed: f.closed, kind: f.kind }))
  }
  check(problems.length === 0, `every prefix of chat-rich-fences's reply (${answer.length} prefixes): closed fences stay closed, kinds wait for the info line`, problems.slice(0, 5).join("; "))
  check(seen.filter((f) => f.closed).length === 6, "the whole reply has six closed fences", JSON.stringify(seen))
  check(seen.filter((f) => f.kind === "mermaid").length === 2 && seen.some((f) => f.kind === "svg"), "the whole reply: two mermaid fences and an svg one")
}
