#!/usr/bin/env node
/**
 * Keeps motion on one system (docs/MOTION.md §9). Runs as part of `pnpm lint`; exits 1 on any finding.
 *
 * Fails on:
 *   - raw timing classes in src: duration-*, delay-*, ease-* (Tailwind's named curves and ease-[…]) and animate-*.
 *     Components name what they are instead: a plain `transition`, or a motion-* utility from globals.css.
 *   - arbitrary properties that set a timing or a token: [--tw-duration:…], [--tw-ease:…], [--motion-…:…], [--ease-…:…]
 *   - transition-all and transition-[…] naming a layout property (width, height, top, margin, …): MOTION.md §8 animates
 *     transform and opacity only, outside ALLOW.layoutTransition (the three of §6.2, from M3)
 *   - a transition* class and a motion-* utility in one class list: the bare `transition` is sorted after the motion-*
 *     utilities in the built CSS, so it silently wins (a motion-* behind a variant the transition lacks is fine)
 *   - transition-none, outside ALLOW.transitionNone
 *   - will-change (classes, CSS or inline styles): MOTION.md §8, "no will-change left on"
 *   - transition / animation declarations in CSS outside the motion block of globals.css
 *     (between the @motion-begin and @motion-end comments: the tokens, the motion-* utilities and the keyframes)
 *   - inside the motion block too: a raw duration or curve in a transition / animation declaration. They read the
 *     tokens (var(--motion-…), var(--ease-…)); 0s and step-start / step-end are allowed, the loops are in ALLOW.cssTiming
 *   - inside the motion block: a transition of anything but opacity, transform (translate, scale, rotate), visibility and
 *     colours, from a transition-property or a transition shorthand (MOTION.md §8: `all`, layout properties, filter,
 *     backdrop-filter, box-shadow fail), outside ALLOW.layoutTransition's { utility, props } entries (§6.2, from M3)
 *   - a motion-* utility whose exit isn't one step faster than its entrance (slow → base, base → fast, fast stays fast;
 *     MOTION.md §3), read from its open, closed and plain rules, ::backdrop on its own, reduced motion aside
 *   - --motion-* / --ease-* declared anywhere but the motion block's token :root (once), or the reduced-motion :root
 *     (--motion-shift: 0px only); --default-transition-* outside the block's @theme; --tw-duration / --tw-ease / --tw-delay
 *   - inline transition / animation styles in components, outside ALLOW.inlineStyle: style objects, `.style.transition… =`
 *     assignments, style.setProperty("transition…" or a token), and token keys in style objects
 *   - the Web Animations API (.animate(), new Animation / KeyframeEffect), outside ALLOW.webAnimations
 *   - src/lib/motion.ts and the tokens in globals.css disagreeing, or the Tailwind defaults not reading the tokens
 *
 * Every run first checks the checker: SELF_TEST plants each of those forms (and a few look-alikes that must pass).
 *
 * Usage: node scripts/check-motion.mjs [--quiet]
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "src")
const CSS_FILE = "src/app/globals.css"
const TOKENS_FILE = "src/lib/motion.ts"

/** Exceptions, each with its reason. Paths are relative to the repo, with forward slashes. */
const ALLOW = {
  /** `transition-none` classes: none today. Add { file, why } entries here only with a reason. */
  transitionNone: [],
  /** Inline `transition: "none"`: drag styles that follow the finger, so nothing may lag behind it (MOTION.md §9). */
  inlineStyle: [
    { file: "src/components/ui/sheet.tsx", value: "none", why: "sheet drag follows the finger" },
    { file: "src/components/app-shell.tsx", value: "none", why: "drawer swipe follows the finger" },
  ],
  /**
   * Layout transitions: none today. MOTION.md §6.2's three (M3) go here, each with its reason: { file } for a
   * transition-all / transition-[width…] class in that file, { utility, props } for a motion-* utility in the motion
   * block that may transition those properties (e.g. { utility: "motion-collapse", props: ["grid-template-rows"] }).
   */
  layoutTransition: [],
  /** Files that may call the Web Animations API: none today (M1's usePresence, if it needs it, lives in src/lib/motion.ts). */
  webAnimations: [],
  /** Literal timings inside the motion block, by rule selector: the loops of MOTION.md §1 and the skeleton's wait. */
  cssTiming: [
    { selector: ".pulse", values: ["1.2s", "ease-in-out"], why: "a loop's rhythm, not a transition (MOTION.md §1)" },
    { selector: ".orbit", values: ["1s", "linear"], why: "a loop's rhythm, not a transition (MOTION.md §1)" },
    { selector: ".skel", values: ["1.6s", "ease-in-out"], why: "a loop's rhythm, not a transition (MOTION.md §1)" },
    { selector: ".skel-in", values: ["160ms"], why: "the don't-flash wait: a threshold, not motion" },
  ],
}

const quiet = process.argv.includes("--quiet")
let findings = []
const fail = (file, line, msg) => findings.push({ file, line, msg })
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/")
const lineAt = (text, index) => text.slice(0, index).split("\n").length

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// ---------------------------------------------------------------- JS / TS sources

/** Keywords after which a slash starts a regex, not a division (`return /x/.test(s)`). */
const REGEX_AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

/**
 * Splits a JS/TS source into string literals (with their line) and the code around them, comments dropped.
 * Template literals give their text parts as strings and their ${…} parts as code. Regex literals are skipped
 * heuristically (a slash where an operand is expected), so a quote inside one doesn't start a string.
 * `code` keeps every newline, so a line in it is the line in the source.
 *
 * Each string also says which class list it belongs to: `group` is shared by a template literal's text parts and
 * every string inside its ${…}; `dynamic` is true for those inner strings (one of a ternary's alternatives, say).
 */
export function scanSource(src) {
  const strings = []
  let code = ""
  let i = 0
  let line = 1
  let groups = 0
  const stack = [] // per open ${ in a template literal: brace depth, and that template's group
  let lastSig = "" // last non-space code character, to tell a regex from a division
  let prevSig = "" // the one before it, to tell `=>` from JSX's `>`
  const sig = (ch) => {
    prevSig = lastSig
    lastSig = ch
  }
  const push = (text, at, group, dynamic) => strings.push({ text, line: at, group, dynamic })
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === "\n") line++
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? src.length : end + 2
      const newlines = (src.slice(i, stop).match(/\n/g) ?? []).length
      line += newlines
      code += "\n".repeat(newlines)
      i = stop
      continue
    }
    if (c === '"' || c === "'") {
      const at = line
      let j = i + 1
      let text = ""
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          text += src[j + 1] ?? ""
          j += 2
          continue
        }
        text += src[j++]
      }
      if (src[j] !== c) {
        // Unclosed on its line: an apostrophe in JSX text ("Don't"), not a string. Read on past it as code.
        code += c
        i++
        continue
      }
      if (stack.length) push(text, at, stack[stack.length - 1].group, true)
      else push(text, at, ++groups, false)
      code += `${c}${strings.length - 1}${c}`
      sig(c)
      i = j + 1
      continue
    }
    if (c === "`" || (c === "}" && stack.length && stack[stack.length - 1].depth === 0)) {
      // Start of a template literal, or back into one after a ${…}.
      let group
      let dynamic
      if (c === "}") ({ group, dynamic } = stack.pop())
      else if (stack.length) {
        group = stack[stack.length - 1].group
        dynamic = true
      } else {
        group = ++groups
        dynamic = false
      }
      const at = line
      let j = i + 1
      let text = ""
      let newlines = 0
      while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) {
        if (src[j] === "\\") {
          text += src[j + 1] ?? ""
          j += 2
          continue
        }
        if (src[j] === "\n") newlines++
        text += src[j++]
      }
      line += newlines
      push(text, at, group, dynamic)
      code += `\`${strings.length - 1}\`${"\n".repeat(newlines)}`
      sig("`")
      if (src[j] === "$") {
        stack.push({ depth: 0, group, dynamic })
        i = j + 2
      } else i = j + 1
      continue
    }
    // `>` starts a regex only as the end of `=>`: after any other `>` it is JSX text (`<p>/ path</p>`), and after `<`
    // or `}` it is JSX too (`</div>`, `<X a={b} />`).
    const regexStart =
      lastSig === "" || "(,=:[!&|?{;+-*%~^".includes(lastSig) || (lastSig === ">" && prevSig === "=") || (/[\w$]/.test(lastSig) && REGEX_AFTER_WORD.test(code.trimEnd()))
    if (c === "/" && regexStart) {
      // A regex literal: skip to its closing slash (not inside a [class]).
      let j = i + 1
      let cls = false
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++
        else if (src[j] === "[") cls = true
        else if (src[j] === "]") cls = false
        else if (src[j] === "/" && !cls) break
        j++
      }
      i = j + 1
      while (/[a-z]/i.test(src[i] ?? "")) i++
      sig("/")
      code += "/re/"
      continue
    }
    if (stack.length) {
      if (c === "{") stack[stack.length - 1].depth++
      else if (c === "}") stack[stack.length - 1].depth--
    }
    code += c
    if (!/\s/.test(c)) sig(c)
    i++
  }
  return { strings, code }
}

/** A class token split into its variants (`max-expanded:hover:`) and the utility it names, without important marks or a negative sign. */
function splitToken(token) {
  let depth = 0
  let cut = 0
  for (let k = 0; k < token.length; k++) {
    const ch = token[k]
    if (ch === "[" || ch === "(") depth++
    else if (ch === "]" || ch === ")") depth--
    else if (ch === ":" && depth === 0) cut = k + 1
  }
  return { variant: token.slice(0, cut), utility: token.slice(cut).replace(/^!/, "").replace(/!$/, "").replace(/^-/, "") }
}
const utilityOf = (token) => splitToken(token).utility

/** The tokens of a string that could be classes. */
const classTokens = (text) => text.split(/\s+/).filter((t) => t && /^[!\w[(-]/.test(t))

const LAYOUT_PROPS = /^(all|width|height|min-|max-|inline-size|block-size|top|left|right|bottom|inset|margin|padding|gap|grid|flex|font-size|line-height|border-width)/

const RAW_CLASS = [
  [/^duration-/, "raw duration class: use `transition` (fast) or a motion-* utility"],
  [/^delay-/, "raw delay class: delays belong in a motion-* utility in globals.css"],
  [/^ease-/, "raw easing class: use `transition` (move) or a motion-* utility"],
  [/^animate-/, "raw animation class: use .skel / .skel-in / .pulse / .orbit, or a motion-* utility"],
  [/^will-change-/, "will-change left on: MOTION.md §8 allows it only during an animation, set from JS"],
  [/^\[(transition|animation|will-change)[\w-]*:/, "arbitrary motion property: timings live in globals.css's motion block"],
  [/^\[--(tw-(duration|ease|delay)|motion-|ease-|default-(transition|animation)-|animate-)[\w-]*:/, "arbitrary timing or token override: timings live in globals.css's motion block"],
  [/^transition-\(/, "transition-(…) reads its properties from a variable, so they can't be checked: name them"],
]

/** transition-all, or transition-[…] naming a layout property. */
function layoutTransition(u) {
  if (u === "transition-all") return "all"
  const m = u.match(/^transition-\[(.*)\]$/)
  if (!m) return null
  return m[1].split(",").map((p) => p.trim()).find((p) => LAYOUT_PROPS.test(p)) ?? null
}

/** Strings naming a motion property or a timing token, as a style key or a setProperty name. */
const MOTION_STYLE_NAME = /^(transition|animation|will-?change)|^--(motion|ease)-|^--tw-(duration|ease|delay)$|^--default-(transition|animation)-/i

function checkSource(file, text) {
  const { strings, code } = scanSource(text)
  for (const s of strings) {
    for (const token of classTokens(s.text)) {
      const u = utilityOf(token)
      for (const [re, msg] of RAW_CLASS) if (re.test(u)) fail(file, s.line, `${token}: ${msg}`)
      const layout = layoutTransition(u)
      if (layout && !ALLOW.layoutTransition.some((a) => a.file === file)) fail(file, s.line, `${token}: transitions ${layout}, a layout property (MOTION.md §8: transform and opacity only; the §6.2 three go in ALLOW.layoutTransition)`)
      if (u === "transition-none" && !ALLOW.transitionNone.some((a) => a.file === file)) fail(file, s.line, `${token}: transition-none is not on the allow-list (scripts/check-motion.mjs, ALLOW.transitionNone)`)
    }
    // CSS text inside a string (a <style> body, an export template) follows the CSS rule.
    for (const m of s.text.matchAll(/(?:^|[;{\s"'])((?:transition|animation)(?:-[a-z-]+)?|will-change)\s*:\s*([^;}"']*)/g)) {
      if (/^(transition|animation)/.test(m[1]) && m[2].trim() === "none" && ALLOW.inlineStyle.some((a) => a.file === file)) continue
      fail(file, s.line, `"${m[1]}: ${m[2].trim()}" in a string: timings live in globals.css's motion block`)
    }
  }
  checkPairs(file, strings)
  const inlineAllowed = (key, value) => !/^will/i.test(key) && ALLOW.inlineStyle.some((a) => a.file === file && a.value === value)
  // Inline style objects: { transition: "…" }, { transitionDuration: … }, { animation: … }, { willChange: … }.
  for (const m of code.matchAll(/(?<![\w$.])(transition|animation|willChange)(Property|Duration|TimingFunction|Delay|Name|IterationCount|FillMode|Direction|PlayState|Behavior)?\s*:\s*(["'`])(\d+)\3/g)) {
    const key = m[1] + (m[2] ?? "")
    const value = strings[Number(m[4])]?.text.trim()
    if (!inlineAllowed(key, value)) fail(file, lineAt(code, m.index), `inline style ${key}: "${value}": use a motion-* utility (or add a drag style to ALLOW.inlineStyle with its reason)`)
  }
  for (const m of code.matchAll(/(?<![\w$.])(transition|animation|willChange)(Property|Duration|TimingFunction|Delay|Name)?\s*:\s*(?![\s"'`])([\w$.([{-]+)/g)) {
    // A computed value: can't be read here, so it can't be allowed either.
    fail(file, lineAt(code, m.index), `inline style ${m[1]}${m[2] ?? ""}: ${m[3]}…: computed inline timings bypass the tokens`)
  }
  // Quoted style keys: { "--motion-fast": "300ms" }, { "transition-duration": … }. A key follows `{` or `,`; a ternary's `? "a" :` is not one.
  for (const m of code.matchAll(/[{,]\s*(["'`])(\d+)\1\s*:(?!:)/g)) {
    const key = strings[Number(m[2])]?.text.trim() ?? ""
    if (MOTION_STYLE_NAME.test(key)) fail(file, lineAt(code, m.index), `inline style "${key}": timings and tokens live in globals.css's motion block`)
  }
  // Assignments: el.style.transition = …, el.style.animationDuration = …, el.style["transition"] = ….
  for (const m of code.matchAll(/\.style\s*(?:\.\s*([\w$]+)|\[\s*(["'`])(\d+)\2\s*\])\s*=(?!=)\s*(?:(["'`])(\d+)\4)?/g)) {
    const key = m[1] ?? strings[Number(m[3])]?.text ?? ""
    if (!MOTION_STYLE_NAME.test(key)) continue
    const value = m[5] !== undefined ? strings[Number(m[5])]?.text.trim() : undefined
    if (value === undefined || !inlineAllowed(key, value)) fail(file, lineAt(code, m.index), `style.${key} = ${value === undefined ? "…" : `"${value}"`}: use a motion-* utility (or add a drag style to ALLOW.inlineStyle with its reason)`)
  }
  // style.setProperty("transition-duration", …) or a token: setProperty("--motion-fast", …).
  for (const m of code.matchAll(/\.setProperty\s*\(\s*(["'`])(\d+)\1/g)) {
    const name = strings[Number(m[2])]?.text.trim() ?? ""
    if (MOTION_STYLE_NAME.test(name)) fail(file, lineAt(code, m.index), `setProperty("${name}", …): timings and tokens live in globals.css's motion block`)
  }
  // The Web Animations API times things itself.
  if (!ALLOW.webAnimations.some((a) => a.file === file)) {
    for (const m of code.matchAll(/\.animate\s*\(|\bnew\s+(?:Animation|KeyframeEffect)\s*\(/g)) {
      fail(file, lineAt(code, m.index), `${m[0].replace(/\s+/g, " ")}…: the Web Animations API bypasses the tokens (use a motion-* utility, or add the file to ALLOW.webAnimations with its reason)`)
    }
  }
}

/**
 * A transition* class and a motion-* utility in one class list: in the built CSS every motion-* utility comes before
 * `.transition` (same specificity), so the bare transition wins and the motion timing is dropped without a word.
 * Only a motion-* behind a variant the transition doesn't have (`transition max-expanded:motion-layer`) is safe.
 * A class list is a string, or a template literal: its text parts with each string inside its ${…} in turn.
 */
function checkPairs(file, strings) {
  const groups = new Map()
  for (const s of strings) {
    const g = groups.get(s.group) ?? { fixed: [], dynamic: [] }
    ;(s.dynamic ? g.dynamic : g.fixed).push(s)
    groups.set(s.group, g)
  }
  const seen = new Set()
  for (const g of groups.values()) {
    const lists = g.dynamic.length ? g.dynamic.map((d) => [...g.fixed, d]) : [g.fixed]
    for (const list of lists) {
      const tokens = list.flatMap((s) => classTokens(s.text).map((token) => ({ token, line: s.line, ...splitToken(token) })))
      const transitions = tokens.filter((t) => /^transition(-|$)/.test(t.utility))
      const motions = tokens.filter((t) => /^motion-[\w-]+$/.test(t.utility))
      for (const t of transitions) {
        for (const m of motions) {
          if (t.variant === "" && m.variant !== "") continue
          const key = `${t.line}:${t.token}:${m.token}`
          if (seen.has(key)) continue
          seen.add(key)
          fail(file, Math.min(t.line, m.line), `${t.token} with ${m.token}: the bare transition wins in the built CSS and drops ${m.utility}'s timing. Use one or the other`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------- CSS

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
}

/** Every declaration in a CSS text (comments stripped): property, value, where it starts, and the rules around it. */
function cssDeclarations(css) {
  const out = []
  const stack = [] // { prelude, id }
  let ids = 0
  let buf = ""
  let start = 0
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === "{") {
      stack.push({ prelude: buf.trim().replace(/\s+/g, " "), id: ++ids })
      buf = ""
      start = i + 1
    } else if (c === ";" || c === "}") {
      const text = buf.trim()
      const colon = text.indexOf(":")
      if (colon > 0 && stack.length && !text.startsWith("@")) {
        out.push({ prop: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim(), index: start + buf.search(/\S/), chain: stack.map((s) => s.prelude), rule: stack[stack.length - 1].id })
      }
      if (c === "}") stack.pop()
      buf = ""
      start = i + 1
    } else buf += c
  }
  return out
}

const CURVE_WORDS = new Set(["ease", "ease-in", "ease-out", "ease-in-out", "linear"])
const isTimingProp = (p) => /^(transition|animation)(-(duration|delay|timing-function))?$/.test(p)

/** What the motion block may transition (MOTION.md §8): opacity, transform and its parts, visibility, and colours. */
const CHEAP_PROPS = /^(opacity|transform|translate|scale|rotate|visibility|color|background-color|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-color|outline-color|text-decoration-color|caret-color|column-rule-color|accent-color|fill|stroke)$/

/**
 * The properties a transition-property value, or a transition shorthand, names. A shorthand item with no property
 * transitions `all` (CSS Transitions §2.6); `none` names nothing.
 */
function transitionedProps(prop, value) {
  const v = value.replace(/!important/g, "").replace(/var\((?:[^()]|\([^()]*\))*\)/g, " ").replace(/\b[\w-]+\([^)]*\)/g, " ")
  const out = []
  for (const item of v.split(",")) {
    const words = item.trim().split(/\s+/).filter(Boolean)
    if (prop === "transition-property") out.push(...words)
    else {
      const name = words.find((w) => !/^[\d.]/.test(w) && !CURVE_WORDS.has(w) && !/^(step-start|step-end|allow-discrete|normal)$/.test(w))
      out.push(name ?? "all")
    }
  }
  return out.filter((p) => p && p !== "none")
}

const DURATION_RANK = { fast: 1, base: 2, slow: 3 }
/** The slowest duration token a transition-duration value reads (0s and none: null). */
function durationRank(value) {
  let rank = null
  for (const m of value.matchAll(/var\(--motion-(fast|base|slow)\)/g)) rank = Math.max(rank ?? 0, DURATION_RANK[m[1]])
  return rank
}
const RANK_NAME = ["", "fast", "base", "slow"]

/** Raw durations and curves in a transition / animation value, after its var(…) reads are taken out. */
function rawTimings(value) {
  const v = value.replace(/!important/g, "").replace(/var\((?:[^()]|\([^()]*\))*\)/g, " ")
  const out = []
  for (const m of v.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/g)) if (Number(m[1]) !== 0) out.push(m[0])
  for (const m of v.matchAll(/\b(cubic-bezier|steps|linear)\([^)]*\)/g)) out.push(m[0])
  for (const word of v.replace(/\b(cubic-bezier|steps|linear)\([^)]*\)/g, " ").split(/[\s,]+/)) if (CURVE_WORDS.has(word)) out.push(word)
  return out
}

function checkCss(file, css) {
  const begin = css.indexOf("/* @motion-begin")
  const endMark = css.indexOf("/* @motion-end */")
  const isTokens = file === CSS_FILE
  if (isTokens && (begin === -1 || endMark === -1 || endMark < begin)) {
    fail(file, 1, "no motion block: expected /* @motion-begin … */ … /* @motion-end */")
    return null
  }
  const plain = stripCssComments(css)
  for (const m of plain.matchAll(/(?<![\w-])((?:transition|animation)(?:-[a-z-]+)?|will-change)\s*:/g)) {
    const inBlock = isTokens && m.index > begin && m.index < endMark
    if (m[1] === "will-change") fail(file, lineAt(css, m.index), "will-change left on: MOTION.md §8 allows it only during an animation, set from JS")
    else if (!inBlock) fail(file, lineAt(css, m.index), `${m[1]}: outside the motion block of ${CSS_FILE}: move it there, or use a motion-* utility`)
  }
  for (const m of plain.matchAll(/@apply\s+([^;]+);/g)) {
    for (const token of m[1].trim().split(/\s+/)) {
      const u = utilityOf(token)
      for (const [re, msg] of RAW_CLASS) if (re.test(u)) fail(file, lineAt(css, m.index), `@apply ${token}: ${msg}`)
    }
  }
  let tokensRule = null
  /** Per motion-* utility (and its ::backdrop): the slowest duration of its plain, open and closed rules. */
  const speeds = new Map()
  for (const d of cssDeclarations(plain)) {
    const inBlock = isTokens && d.index > begin && d.index < endMark
    const line = lineAt(css, d.index)
    const outer = d.chain[0] ?? ""
    const selector = [...d.chain].reverse().find((p) => !/^@(media|supports|container|layer)\b/.test(p)) ?? ""
    // Inside the block, transitions and animations read the tokens.
    if (inBlock && isTimingProp(d.prop)) {
      const allowed = ALLOW.cssTiming.find((a) => a.selector === selector)?.values ?? []
      for (const raw of new Set(rawTimings(d.value))) if (!allowed.includes(raw)) fail(file, line, `${selector} { ${d.prop}: … ${raw} … }: a raw timing in the motion block: use var(--motion-…) / var(--ease-…) (loops: ALLOW.cssTiming)`)
    }
    // Inside the block, only cheap properties are transitioned (MOTION.md §8).
    const utility = outer.match(/^@utility\s+([\w-]+)/)?.[1] ?? null
    if (inBlock && (d.prop === "transition-property" || d.prop === "transition")) {
      for (const p of transitionedProps(d.prop, d.value)) {
        if (CHEAP_PROPS.test(p)) continue
        if (utility && ALLOW.layoutTransition.some((a) => a.utility === utility && (a.props ?? []).includes(p))) continue
        fail(file, line, `${selector} { ${d.prop}: ${d.value} }: transitions ${p}. MOTION.md §8: opacity, transform and colours only, never backdrop-filter (§6.2's layout three go in ALLOW.layoutTransition as { utility, props })`)
      }
    }
    // Exits one step faster than entrances (MOTION.md §3): collect each motion-* utility's durations, reduced motion aside.
    if (inBlock && utility?.startsWith("motion-") && !d.chain.some((p) => /^@(media|starting-style)\b/.test(p))) {
      const rules = d.chain.slice(1).join(" ")
      const key = `${utility}${/::backdrop/.test(rules) ? "::backdrop" : ""}`
      const s = speeds.get(key) ?? { line, plain: null, open: null, closed: null, states: false }
      speeds.set(key, s)
      const state = /\[data-state="closed"\]|\[data-open="false"\]/.test(rules) ? "closed" : /\[data-state="open"\]|\[data-open="true"\]/.test(rules) ? "open" : /^(&(::backdrop)?)?$/.test(rules) ? "plain" : null
      if (state === "open" || state === "closed") s.states = true
      const rank = d.prop === "transition-duration" ? durationRank(d.value) : null
      if (state && rank !== null) s[state] = Math.max(s[state] ?? 0, rank)
    }
    // The tokens are declared once, in the block's :root; reduced motion may only zero --motion-shift.
    if (/^--(motion|ease)-/.test(d.prop)) {
      const isRoot = d.chain.length === 1 && outer === ":root"
      if (inBlock && isRoot && (tokensRule === null || tokensRule === d.rule)) tokensRule = d.rule
      else if (inBlock && d.chain.length === 2 && /^@media \(prefers-reduced-motion: ?reduce\)$/.test(outer) && d.chain[1] === ":root" && d.prop === "--motion-shift" && /^0(px)?$/.test(d.value)) continue
      else fail(file, line, `${d.prop}: ${d.value}: tokens are declared once, in the motion block's :root of ${CSS_FILE} (reduced motion may only set --motion-shift: 0px)`)
    }
    if (/^--default-(transition|animation)-/.test(d.prop) && !(inBlock && outer.startsWith("@theme"))) fail(file, line, `${d.prop}: the Tailwind defaults are set once, in the motion block's @theme`)
    if (/^--tw-(duration|ease|delay)$/.test(d.prop)) fail(file, line, `${d.prop}: Tailwind's own duration-/ease-/delay- utilities set this; writing it bypasses the tokens`)
  }
  for (const [key, s] of speeds) {
    // Only a utility with an open or closed state has an entrance and an exit (motion-fade and motion-reveal don't).
    const enter = s.open ?? s.plain
    const exit = s.closed ?? s.plain
    if (!s.states || enter === null || exit === null) continue
    const want = Math.max(1, enter - 1)
    if (exit !== want) fail(file, s.line, `${key}: its exit runs on --motion-${RANK_NAME[exit]} after an entrance on --motion-${RANK_NAME[enter]}: exits are one step faster, so --motion-${RANK_NAME[want]} (MOTION.md §3)`)
  }
  return isTokens ? plain.slice(begin, endMark) : null
}

// ---------------------------------------------------------------- tokens in sync

const norm = (v) => v.replace(/\s+/g, "").toLowerCase()

function checkTokens(block) {
  const ts = readFileSync(path.join(ROOT, TOKENS_FILE), "utf8")
  const object = (name) => {
    const m = ts.match(new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as const`))
    if (!m) return null
    const out = {}
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    for (const e of body.matchAll(/(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))/g)) out[e[1]] = e[4] !== undefined ? Number(e[4]) : (e[2] ?? e[3])
    return out
  }
  const motion = object("motion")
  const ease = object("ease")
  if (!motion || !ease) {
    fail(TOKENS_FILE, 1, "can't read `export const motion = { … } as const` and `export const ease = { … } as const`")
    return
  }
  // The first :root block in the motion block holds the tokens (checkCss fails any second declaration of them).
  const root = block.match(/:root\s*\{([^}]*)\}/)
  if (!root) {
    fail(CSS_FILE, 1, "the motion block has no :root { … } with the tokens")
    return
  }
  const css = {}
  for (const d of root[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) css[d[1]] = d[2].trim()
  const want = {}
  for (const [k, v] of Object.entries(motion)) want[`motion-${k}`] = k === "shift" ? `${v}px` : `${v}ms`
  for (const [k, v] of Object.entries(ease)) want[`ease-${k}`] = v
  const tokensLine = lineAt(readFileSync(path.join(ROOT, CSS_FILE), "utf8"), readFileSync(path.join(ROOT, CSS_FILE), "utf8").indexOf("--motion-fast"))
  for (const [name, value] of Object.entries(want)) {
    if (!(name in css)) fail(CSS_FILE, tokensLine, `--${name} is in ${TOKENS_FILE} (${value}) but not in the motion block's :root`)
    else if (norm(css[name]) !== norm(value)) fail(CSS_FILE, tokensLine, `--${name}: ${css[name]} here, ${value} in ${TOKENS_FILE}`)
  }
  for (const name of Object.keys(css)) {
    if (/^(motion|ease)-/.test(name) && !(name in want)) fail(CSS_FILE, tokensLine, `--${name} is in globals.css but not in ${TOKENS_FILE}`)
  }
  // Every bare `transition` must run on the tokens (MOTION.md §3, "Tailwind defaults").
  const dur = block.match(/--default-transition-duration\s*:\s*([^;]+);/)
  const fn = block.match(/--default-transition-timing-function\s*:\s*([^;]+);/)
  if (!dur || !/^var\(--motion-(fast|base|slow)\)$/.test(norm(dur[1]))) fail(CSS_FILE, tokensLine, "--default-transition-duration must be a var(--motion-…) token, in the motion block's @theme")
  if (!fn || !/^var\(--ease-(arrive|leave|move)\)$/.test(norm(fn[1]))) fail(CSS_FILE, tokensLine, "--default-transition-timing-function must be a var(--ease-…) token, in the motion block's @theme")
}

// ---------------------------------------------------------------- self-test

const TSX = "src/components/zz-self-test.tsx"
const block = (body, after = "") => `/* @motion-begin */\n:root {\n  --motion-fast: 120ms;\n}\n${body}\n/* @motion-end */\n${after}`

/**
 * The checker's own test: every form the M0 review planted past it (must fail), and look-alikes (must pass).
 * `match` narrows which finding counts.
 */
const SELF_TEST = [
  { name: "style.transition assignment", src: `el.style.transition = "opacity 300ms linear"`, fails: /style\.transition/ },
  { name: "style[…] assignment", src: `el.style["transitionDuration"] = "300ms"`, fails: /style\.transitionDuration/ },
  { name: "setProperty transition", src: `el.style.setProperty("transition-duration", "300ms")`, fails: /setProperty/ },
  { name: "setProperty token", src: `document.documentElement.style.setProperty("--motion-fast", "300ms")`, fails: /setProperty/ },
  { name: "WAAPI animate", src: `el.animate([{ opacity: 0 }], { duration: 300, easing: "linear" })`, fails: /Web Animations/ },
  { name: "WAAPI KeyframeEffect", src: `new KeyframeEffect(el, [], 300)`, fails: /Web Animations/ },
  { name: "[--tw-duration:]", src: `<div className="transition [--tw-duration:300ms]" />`, fails: /--tw-duration/ },
  { name: "[--tw-ease:]", src: `<div className="transition [--tw-ease:cubic-bezier(0,0,1,1)]" />`, fails: /--tw-ease/ },
  { name: "[--motion-fast:]", src: `<div className="[--motion-fast:300ms]" />`, fails: /--motion-fast/ },
  { name: "transition-[width]", src: `<div className="transition-[width]" />`, fails: /layout property/ },
  { name: "transition-all", src: `<div className="transition-all" />`, fails: /layout property/ },
  { name: "token style key", src: `<div style={{ "--motion-fast": "300ms" }} />`, fails: /inline style "--motion-fast"/ },
  { name: "JSX text starting with /", src: `const a = <p>/ <span className="duration-200">x</span></p>`, fails: /duration-200/ },
  { name: "transition + motion-fade", src: `<div className="transition motion-fade" />`, fails: /drops motion-fade/ },
  { name: "transition + motion-* in a template", src: "<div className={`transition ${a ? \"motion-sheet\" : \"\"}`} />", fails: /drops motion-sheet/ },
  { name: "control: motion-safe:animate-spin", src: `<div className="motion-safe:animate-spin" />`, fails: /animate-spin/ },
  { name: "raw timing in a block utility", css: block("@utility motion-pop { transition: opacity 300ms ease-in, scale 300ms ease-in; }"), fails: /300ms/ },
  { name: "raw curve in a block utility", css: block("@utility motion-pop { transition-timing-function: cubic-bezier(0, 0, 1, 1); }"), fails: /cubic-bezier/ },
  { name: "tokens redeclared after the block", css: block("", `[data-theme="dark"] { --motion-fast: 400ms; --ease-move: linear; }`), fails: /declared once/ },
  { name: "a second token :root in the block", css: block(":root { --motion-fast: 300ms; }"), fails: /declared once/ },
  { name: "reduced motion retimes a token", css: block("@media (prefers-reduced-motion: reduce) { :root { --motion-base: 120ms; } }"), fails: /declared once/ },
  { name: "--tw-duration in CSS", css: block("", ".x { --tw-duration: 300ms; }"), fails: /--tw-duration/ },
  { name: "a layout property in a block utility", css: block("@utility motion-pop { transition-property: opacity, transform, height; }"), fails: /transitions height/ },
  { name: "transition-property: all in the block", css: block("@utility motion-pop { transition-property: all; }"), fails: /transitions all/ },
  { name: "backdrop-filter in the block", css: block("@utility motion-layer { transition-property: opacity, backdrop-filter; }"), fails: /transitions backdrop-filter/ },
  { name: "box-shadow in the block", css: block(".x { transition-property: box-shadow; }"), fails: /transitions box-shadow/ },
  { name: "a shorthand naming width", css: block("@utility motion-x { transition: width var(--motion-fast) var(--ease-move); }"), fails: /transitions width/ },
  { name: "a shorthand naming no property (all)", css: block("@utility motion-x { transition: var(--motion-fast) var(--ease-move); }"), fails: /transitions all/ },
  {
    name: "an exit slower than its entrance",
    css: block('@utility motion-x { transition-duration: var(--motion-base); &[data-state="closed"] { transition-duration: var(--motion-slow); } }'),
    fails: /one step faster/,
  },
  {
    name: "a backdrop exit as slow as its entrance",
    css: block('@utility motion-x { transition-duration: var(--motion-slow); &::backdrop { transition-duration: var(--motion-slow); } &[data-state="closed"] { transition-duration: var(--motion-base); } &[data-state="closed"]::backdrop { transition-duration: var(--motion-slow); } }'),
    fails: /motion-x::backdrop: its exit/,
  },
  { name: "regex after =>", src: `const re = (s) => /"duration-200"/.test(s)`, passes: true },
  { name: "regex after return", src: `function f(x) { return /"ease-in"/.test(x) }`, passes: true },
  { name: "JSX text starting with /, clean", src: `const a = <p>/ <span className="transition">x</span></p>`, passes: true },
  { name: "transition + variant motion-*", src: `<div className="transition max-expanded:motion-layer" />`, passes: true },
  { name: "motion-* with a ternary", src: "<div className={`motion-fade ${a ? \"opacity-50\" : \"\"}`} />", passes: true },
  { name: "setProperty of another variable", src: `root.style.setProperty("--app-h", "10px")`, passes: true },
  { name: "a ternary's string is not a style key", src: `<span className={mine ? "transition-colors opacity-0" : ""} />`, passes: true },
  {
    name: "the block's own forms",
    css: block(
      [
        "@media (prefers-reduced-motion: reduce) { :root { --motion-shift: 0px; } }",
        "@theme inline { --default-transition-duration: var(--motion-fast); }",
        "@utility motion-x { transition-duration: var(--motion-slow), var(--motion-slow), 0s; transition-timing-function: var(--ease-arrive); }",
        ".pulse { animation: pulse-dot 1.2s ease-in-out infinite; }",
        ".skel-in { animation: skel-appear var(--motion-slow) var(--ease-arrive) 160ms both; }",
        "@media (prefers-reduced-motion: reduce) { .skel-in { animation-timing-function: step-start; } }",
        ":root[data-theme-switching] * { transition: none !important; }",
        "@utility motion-y { transition-property: translate, opacity, visibility; transition-duration: var(--motion-base); &:where([data-open=\"true\"], [data-state=\"open\"]) { transition-duration: var(--motion-slow), var(--motion-slow), 0s; } }",
        '@utility motion-z { transition-property: opacity, scale; transition-duration: var(--motion-base); &[data-state="closed"] { transition-duration: var(--motion-fast); } &[data-backdrop="instant"][data-state="open"]::backdrop { transition-duration: 0s; } }',
        '@utility motion-w { transition-property: opacity; transition-duration: var(--motion-fast); &[data-state="closed"] { opacity: 0; } @media (prefers-reduced-motion: reduce) { &[data-state="closed"] { transition-duration: var(--motion-fast); } } }',
        ".tab { transition-property: color, background-color, border-color; }",
      ].join("\n"),
    ),
    passes: true,
  },
]

function selfTest() {
  const saved = findings
  const broken = []
  try {
    for (const t of SELF_TEST) {
      findings = []
      if (t.src !== undefined) checkSource(TSX, t.src)
      else checkCss(CSS_FILE, t.css)
      const got = findings.map((f) => f.msg)
      if (t.passes && got.length) broken.push(`${t.name}: should pass, got: ${got.join(" | ")}`)
      if (t.fails && !got.some((m) => t.fails.test(m))) broken.push(`${t.name}: should fail with ${t.fails}, got: ${got.join(" | ") || "nothing"}`)
    }
  } finally {
    findings = saved
  }
  return broken
}

// ---------------------------------------------------------------- run

const invoked = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invoked) {
  const broken = selfTest()
  if (broken.length) {
    console.error(`check-motion: its self-test failed, so its verdict can't be trusted (scripts/check-motion.mjs, SELF_TEST)\n`)
    for (const b of broken) console.error(`  ${b}`)
    process.exit(1)
  }
  const files = walk(SRC)
  let motionBlock = null
  for (const abs of files) {
    const file = rel(abs)
    const text = readFileSync(abs, "utf8")
    if (/\.(tsx?|jsx?|mjs|cjs)$/.test(abs)) checkSource(file, text)
    else if (abs.endsWith(".css")) {
      const b = checkCss(file, text)
      if (b !== null) motionBlock = b
    }
  }
  if (motionBlock !== null) checkTokens(motionBlock)
  else if (!findings.some((f) => f.file === CSS_FILE)) fail(CSS_FILE, 1, "not found")

  if (findings.length) {
    console.error(`check-motion: ${findings.length} problem${findings.length === 1 ? "" : "s"} (docs/MOTION.md §9)\n`)
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.msg}`)
    process.exit(1)
  }
  if (!quiet) console.log(`check-motion: ok (${files.length} files in src; self-test ${SELF_TEST.length} cases)`)
}
