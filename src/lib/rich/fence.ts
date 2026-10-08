/**
 * The fence closure rule (docs/RENDERING.md §2.4). Pure, main chunk. A fence is drawn only once it is closed or its
 * text is final, so a renderer never parses half-typed input; its kind is decided only after the info line's newline.
 */

export interface FenceState {
  marker: "`" | "~" | "$"
  run: number
  /** The info line is complete (the raw text holds a newline): only then is the language known. */
  infoDone: boolean
  closed: boolean
}

/**
 * `raw`: the fence's own slice of the Markdown source (the `pre` node's position), from its opener to its end. Lines
 * lose their list indent and quote markers; the last line closes the fence when it is the opener's marker repeated at
 * least as often, alone on its line.
 */
export function fenceState(raw: string): FenceState {
  const infoDone = raw.includes("\n")
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").replace(/^[ \t>]*/, ""))
  const first = lines[0] ?? ""
  const c = first[0]
  const marker: FenceState["marker"] = c === "~" ? "~" : c === "$" ? "$" : "`"
  let run = 0
  while (first[run] === marker) run++
  if (marker === "$") run = Math.min(run, 2)
  const esc = marker === "$" ? "\\$" : marker
  const closer = new RegExp(`^(?:${esc}){${Math.max(run, 1)},}[ \\t]*$`)
  const closed = lines.length >= 2 && closer.test(lines[lines.length - 1])
  return { marker, run, infoDone, closed }
}

/**
 * The body of a fence that never closed (the model forgot the closer, or the turn was cut): a last line of one or two
 * backticks or tildes, or a lone `$`, is the start of a closer, not content.
 */
export function trimPartialCloser(body: string, marker: FenceState["marker"]): string {
  const text = body.endsWith("\n") ? body.slice(0, -1) : body
  const nl = text.lastIndexOf("\n")
  const last = text.slice(nl + 1).trim()
  const partial = marker === "$" ? /^\$$/ : marker === "~" ? /^~{1,2}$/ : /^`{1,2}$/
  if (!partial.test(last)) return body
  return nl < 0 ? "" : text.slice(0, nl + 1)
}

/** cyrb53 in base 36, plus ":" and the length: cheap enough for every typewriter frame, and keys never collide by length. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}:${s.length}`
}
