/**
 * A small line-based highlighter for the read-only code view: comments,
 * strings, numbers, keywords and markup tags. Approximate on purpose; block
 * comments and triple-quoted strings carry over between lines.
 */

export type Tok = { t: "" | "k" | "s" | "c" | "n" | "tag"; v: string }

type Lang = { line?: string[]; block?: [string, string][]; quotes: string[]; keywords: Set<string>; markup?: boolean }

const kw = (s: string) => new Set(s.split(" "))

const C_KW = kw(
  "if else for while do switch case break continue return function const let var class extends new this super import export from default try catch finally throw async await yield typeof instanceof in of null undefined true false void interface type enum implements public private protected static readonly abstract package struct func go chan defer map range fn impl mut pub use mod match loop where trait self Self crate as int float double char long short bool boolean string unsigned signed sizeof namespace using virtual override template typename nil val fun when object companion is lateinit echo foreach elseif endif",
)
const PY_KW = kw("def class return if elif else for while in not and or is None True False import from as with try except finally raise pass break continue lambda yield global nonlocal assert del async await self print")
const SH_KW = kw("if then else elif fi for while do done case esac function in return export local echo exit set unset true false")
const SQL_KW = kw("select from where insert into values update set delete create table drop alter add join left right inner outer on group by order having limit offset as and or not null primary key foreign references index distinct union all case when then else end")

const LANGS: Record<string, Lang> = {
  c: { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"], keywords: C_KW },
  css: { block: [["/*", "*/"]], quotes: ['"', "'"], keywords: kw("important media import from to") },
  py: { line: ["#"], block: [['"""', '"""'], ["'''", "'''"]], quotes: ['"', "'"], keywords: PY_KW },
  sh: { line: ["#"], quotes: ['"', "'"], keywords: SH_KW },
  conf: { line: ["#", ";"], quotes: ['"', "'"], keywords: kw("true false null yes no on off") },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: ["'", '"'], keywords: SQL_KW },
  markup: { block: [["<!--", "-->"]], quotes: ['"', "'"], keywords: new Set(), markup: true },
}

const BY_EXT: Record<string, keyof typeof LANGS> = {}
for (const [lang, exts] of Object.entries({
  c: "js jsx ts tsx mjs cjs mts cts java c h cc cpp hpp cxx cs go rs swift kt kts scala dart php json jsonc json5 zig groovy gradle",
  css: "css scss sass less",
  py: "py pyw pyi",
  sh: "sh bash zsh fish ps1 psm1 bat cmd dockerfile makefile mk rb pl r",
  conf: "yml yaml toml ini cfg conf env properties gitignore editorconfig",
  sql: "sql",
  markup: "html htm xml svg vue svelte astro",
})) {
  for (const e of exts.split(" ")) BY_EXT[e] = lang as keyof typeof LANGS
}

export function langOf(name: string): string | null {
  const lower = name.toLowerCase()
  if (lower === "dockerfile" || lower === "makefile") return "sh"
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
  return BY_EXT[ext] ?? null
}

const NUM = /^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i
const WORD = /^[A-Za-z_$][\w$]*/

/** Tokens per line. `lang` from langOf; null gives plain lines. */
export function highlight(text: string, lang: string | null): Tok[][] {
  const lines = text.split(/\r?\n/)
  const L = lang ? LANGS[lang] : null
  if (!L) return lines.map((v) => [{ t: "", v }])
  const out: Tok[][] = []
  // Open block comment / triple string carried across lines: [end marker, token type].
  let open: [string, Tok["t"]] | null = null
  for (const line of lines) {
    const toks: Tok[] = []
    const push = (t: Tok["t"], v: string) => {
      if (!v) return
      const last = toks[toks.length - 1]
      if (last && last.t === t) last.v += v
      else toks.push({ t, v })
    }
    let i = 0
    if (open) {
      const end = line.indexOf(open[0])
      if (end < 0) {
        push(open[1], line)
        out.push(toks)
        continue
      }
      push(open[1], line.slice(0, end + open[0].length))
      i = end + open[0].length
      open = null
    }
    let inTag = false
    while (i < line.length) {
      const rest = line.slice(i)
      const lc = L.line?.find((m) => rest.startsWith(m))
      if (lc && !inTag) {
        push("c", rest)
        break
      }
      const bc = L.block?.find(([s]) => rest.startsWith(s))
      if (bc) {
        const t: Tok["t"] = bc[0].startsWith('"') || bc[0].startsWith("'") ? "s" : "c"
        const end = rest.indexOf(bc[1], bc[0].length)
        if (end < 0) {
          push(t, rest)
          open = [bc[1], t]
          break
        }
        push(t, rest.slice(0, end + bc[1].length))
        i += end + bc[1].length
        continue
      }
      if (L.markup) {
        const tag = rest.match(/^<\/?[A-Za-z][\w:-]*|^\/?>/)
        if (tag) {
          push("tag", tag[0])
          inTag = !tag[0].endsWith(">")
          i += tag[0].length
          continue
        }
        if (!inTag) {
          const txt = rest.match(/^[^<]+/)
          push("", txt ? txt[0] : rest[0])
          i += txt ? txt[0].length : 1
          continue
        }
      }
      const q = L.quotes.find((m) => rest.startsWith(m))
      if (q) {
        let j = 1
        while (j < rest.length && rest[j] !== q) j += rest[j] === "\\" ? 2 : 1
        push("s", rest.slice(0, j + 1))
        i += j + 1
        continue
      }
      const prev = line[i - 1]
      const num = !prev || !/[\w$]/.test(prev) ? rest.match(NUM) : null
      if (num) {
        push("n", num[0])
        i += num[0].length
        continue
      }
      const w = rest.match(WORD)
      if (w) {
        push(L.keywords.has(L === LANGS.sql ? w[0].toLowerCase() : w[0]) ? "k" : "", w[0])
        i += w[0].length
        continue
      }
      push("", rest[0])
      i++
    }
    out.push(toks)
  }
  return out
}
