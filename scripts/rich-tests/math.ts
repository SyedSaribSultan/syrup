/**
 * The math parser (docs/RENDERING.md §2.5): Pandoc's dollar rule through the chat's own Markdown parse, and the
 * normalizer for \(…\) and \[…\], which leaves code alone.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { normalize, plugins } from "@/lib/rich/math-parse"

type Check = (ok: boolean, label: string, detail?: string) => void

const html = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, ...plugins] }, normalize(md)))
const inline = (h: string) => (h.match(/math-inline/g) ?? []).length
const display = (h: string) => (h.match(/math-display/g) ?? []).length

export default function run(check: Check) {
  const prose = [
    ["$5 and $10", "currency"],
    ["It costs $5, or $10 with tax.", "currency in a sentence"],
    ["$PATH and $HOME", "shell variables"],
    ["Set `$HOME` and run `echo $PATH`.", "dollars in inline code"],
    ["Between $ 5 and $ 10", "spaced dollars"],
    ["Prices: $3.50 to $4.75 each", "decimal prices"],
    ["```sh\necho $HOME $PATH\n```", "dollars in a code block"],
  ]
  for (const [md, what] of prose) {
    const h = html(md)
    check(inline(h) === 0 && display(h) === 0, `stays prose: ${what}`, h)
  }
  for (const md of ["$x^2$", "$E = mc^2$", "$r$", "where $c_i$ is the price"]) {
    const h = html(md)
    check(inline(h) === 1, `inline math: ${md}`, h)
  }
  check(display(html("$$\n\\sum_i x_i\n$$")) === 1, "$$ on lines of their own is display math")
  check(inline(html("inline $$x^2$$ here")) === 1, "$$…$$ inside a line is math (drawn in the line at display size)")
  check(inline(html("$5 for $x$")) <= 1, "a price before real math never swallows the text between them", html("$5 for $x$"))

  check(normalize("so \\(a\\) holds") === "so $a$ holds", "\\(a\\) → $a$")
  check(normalize("\\[\nx = 1\n\\]") === "$$\nx = 1\n$$", "\\[…\\] → $$…$$ across lines")
  check(normalize("a \\( b + c \\) d") === "a $b + c$ d", "\\( … \\) loses the spaces Pandoc's rule would reject")
  check(normalize("```tex\n\\(a\\) \\[b\\]\n```") === "```tex\n\\(a\\) \\[b\\]\n```", "untouched inside a fenced block")
  check(normalize("use `\\(a\\)` here") === "use `\\(a\\)` here", "untouched inside inline code")
  check(normalize("```\ncode\n```\nthen \\(x\\)") === "```\ncode\n```\nthen $x$", "after a fence closes, prose is normalized again")
  check(normalize("no math here") === "no math here", "text without \\( or \\[ comes back as is")
  check(inline(html("so \\(a\\) holds")) === 1 && display(html("\\[\nx = 1\n\\]")) === 1, "normalized text parses as math")

  // Review findings (2026-10-08): the normalizer inside dollars, after an escaped backslash, and on escaped link brackets.
  const B = String.fromCharCode(92)
  const t = (s: string) => s.replaceAll("@", B)
  const aligned = t("$$@begin{aligned} a &= b @@[4pt] c &= d @end{aligned}$$")
  check(normalize(aligned) === aligned, "TeX inside $$…$$ keeps its \\\\[4pt] row break", normalize(aligned))
  check(normalize(t("$$@begin{aligned} a &= b @@[4pt] c @end{aligned}$$\n\nThen @[x^2@] too.")) === t("$$@begin{aligned} a &= b @@[4pt] c @end{aligned}$$\n\nThen $$x^2$$ too."), "a later \\[x^2\\] still becomes math, without swallowing the $$ block", normalize(t("$$@begin{aligned} a &= b @@[4pt] c @end{aligned}$$\n\nThen @[x^2@] too.")))
  check(normalize(t("Markdown link escape: @[x@](http://a)")) === t("Markdown link escape: @[x@](http://a)"), "escaped link brackets \\[x\\](url) stay a link")
  check(normalize(t("a @@[not math@@] b")) === t("a @@[not math@@] b"), "an escaped backslash before [ is not an opener")
  check(normalize(t("inline $a @(b@) c$ and @(d@)")) === t("inline $a @(b@) c$ and $d$"), "\\( inside $…$ is left alone; outside it becomes math")
  const nest = t("$$@begin{aligned} a &= b @@[4pt] c &= d @end{aligned}$$")
  check(inline(html(nest)) === 1, "the aligned block parses as one formula (inline $$…$$, drawn at display size)", html(nest))
  // Prose JSON: "$ref" and "$id" are keys, not math.
  check(inline(html('Use { "a": "$ref", "b": "$id" } here.')) === 0, "JSON keys with dollars stay prose", html('Use { "a": "$ref", "b": "$id" } here.'))
  check(inline(html("the cost $x$, then more")) === 1, "math followed by a comma is still math")
}
