"use client"

import { createContext, memo, useContext, useMemo, useRef, useState, type ComponentProps } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { useOptionalEngine } from "@/lib/engine-store"
import { copyText, filePathIn } from "@/lib/file-actions"
import { loadMath, MATH_MARK, useLazy } from "@/lib/rich/lazy"
import { FenceSlot, InlineMath, MdContext, type FenceOrigin } from "./rich/slot"
import { FileLink } from "./file-link"

const InPre = createContext(false)

/** Inline code that is a workspace file path becomes a FileLink; code blocks stay as they are. Inline math goes to KaTeX. */
function Code({ node, children, ...props }: ComponentProps<"code"> & { node?: unknown }) {
  const inPre = useContext(InPre)
  const directory = useOptionalEngine()?.directory ?? ""
  const isMath = !inPre && typeof props.className === "string" && props.className.includes("math-inline")
  if (isMath) return <InlineMath node={node as Parameters<typeof InlineMath>[0]["node"]}>{children}</InlineMath>
  const text = typeof children === "string" ? children : null
  const file = !inPre && text ? filePathIn(text, directory) : null
  if (!file) return <code {...props}>{children}</code>
  return (
    <FileLink path={text!}>
      <code {...props}>{children}</code>
    </FileLink>
  )
}

const components: Components = {
  a: ({ node, ...props }) => {
    void node
    return <a {...props} target="_blank" rel="noreferrer" />
  },
  // A fence may be a picture (Mermaid, SVG) or display math: the slot decides, and falls back to the code block.
  pre: ({ node, ...props }) => (
    <FenceSlot node={node as Parameters<typeof FenceSlot>[0]["node"]}>
      <InPre.Provider value={true}>
        <CodeBlock {...props} />
      </InPre.Provider>
    </FenceSlot>
  ),
  // Wide tables scroll inside themselves instead of widening the chat column.
  table: ({ node, ...props }) => {
    void node
    return (
      <div className="md-table">
        <table {...props} />
      </div>
    )
  },
  code: Code,
}

/** A code block with a copy button: shown on hover with a mouse, always on touch screens. */
export function CodeBlock(props: ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="group/code relative">
      <pre ref={ref} {...props} />
      <button
        type="button"
        onClick={() =>
          void copyText(ref.current?.textContent ?? "").then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
        className="absolute top-1.5 right-1.5 rounded-md border border-line bg-surface px-2 py-0.5 font-sans text-[11px] text-ink-2 opacity-0 transition group-hover/code:opacity-100 focus-visible:opacity-100 hover:text-ink pointer-coarse:px-3 pointer-coarse:py-1.5 pointer-coarse:opacity-100"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  )
}

type MathModule = Awaited<ReturnType<typeof loadMath>>

const BASE_PLUGINS = [remarkGfm]
/** One list per loaded parser, so the plugins keep their identity across renders. */
let mathPlugins: { mod: MathModule; list: MathModule["plugins"] } | null = null
function pluginsWith(mod: MathModule) {
  if (mathPlugins?.mod !== mod) mathPlugins = { mod, list: [remarkGfm, ...mod.plugins] }
  return mathPlugins.list
}

/**
 * `final`: the text will not grow any more (finished, or the turn ended), so an unclosed fence is drawn rather than
 * kept as a skeleton (docs/RENDERING.md §2.4). `origin`: the part it belongs to (repairs write back there, Round 2b).
 */
export const Markdown = memo(function Markdown({ text, final = true, origin }: { text: string; final?: boolean; origin?: FenceOrigin }) {
  // The math parser loads the first time a text may hold math; until it has, the text shows as it is, marked busy.
  const wantsMath = MATH_MARK.test(text)
  const math = useLazy(loadMath, wantsMath)
  const mod = wantsMath ? math.module : null
  const source = mod ? mod.normalize(text) : text
  const ctx = useMemo(() => ({ source, final, origin: origin ?? null }), [source, final, origin])
  return (
    <div className="md" aria-busy={(wantsMath && !math.module && !math.failed) || undefined}>
      <MdContext.Provider value={ctx}>
        <ReactMarkdown remarkPlugins={mod ? pluginsWith(mod) : BASE_PLUGINS} components={components}>
          {source}
        </ReactMarkdown>
      </MdContext.Provider>
    </div>
  )
})
