/**
 * The KaTeX renderer (src/components/rich/renderers/math.tsx): TeX that would crash KaTeX (deep nesting throws a
 * RangeError, which throwOnError doesn't catch) or draw outside its own box comes back as escaped code, never thrown.
 */
import { refuseTex, texToHtml } from "@/components/rich/renderers/math"

type Check = (ok: boolean, label: string, detail?: string) => void

const B = String.fromCharCode(92)
const t = (s: string) => s.replaceAll("@", B)

export default function run(check: Check) {
  const code = (h: string) => h.startsWith('<code class="rich-tex-raw')
  const deep = "{".repeat(5000) + "x" + "}".repeat(5000)
  let out = ""
  let threw = false
  try {
    out = texToHtml(deep, false)
  } catch {
    threw = true
  }
  check(!threw && code(out), "5,000 nested braces: shown as code, nothing thrown", out.slice(0, 80))
  const nested = t("@frac{1}{".repeat(400) + "x" + "}".repeat(400))
  threw = false
  try {
    out = texToHtml(nested, true)
  } catch {
    threw = true
  }
  check(!threw && code(out), "400 nested \\frac: shown as code, nothing thrown", out.slice(0, 80))
  check(code(texToHtml("x".repeat(5000), false)), "over 4,000 characters: shown as code")
  for (const s of ["@kern{-200em}x", "@kern -2em x", "@mkern-30mu x", "@hskip -3em x", "@mskip-9mu x", "@hspace{-1em}x", "@hspace*{-1em}x", "@llap{x}", "@rlap{x}", "@clap{x}", "@mathllap{x}", "@mathrlap{@raisebox{3em}{SYSTEM}}", "@mathclap{x}"]) {
    check(refuseTex(t(s)) !== null && code(texToHtml(t(s), false)), `draws outside its box, shown as code: ${t(s)}`)
  }
  for (const s of ["x^2", "@frac{a}{b}", "@kern{2em}x", "@hspace{1em}", "@sqrt{@frac{@partial^2 u}{@partial x^2}}", "@sum_{i=1}^{n} q_i c_i", "@left( @vphantom{x} y @right)"]) {
    const h = texToHtml(t(s), false)
    check(refuseTex(t(s)) === null && h.includes('class="katex"'), `typeset: ${t(s)}`, h.slice(0, 80))
  }
  check(texToHtml(t("<img src=x onerror=alert(1)> @llap{x}"), false).includes("&lt;img"), "code is escaped HTML")
}
