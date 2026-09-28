"use client"

import { createContext, memo, useContext, useRef, useState, type ComponentProps } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { useOptionalEngine } from "@/lib/engine-store"
import { copyText, filePathIn } from "@/lib/file-actions"
import { FileLink } from "./file-link"

const InPre = createContext(false)

/** Inline code that is a workspace file path becomes a FileLink; code blocks stay as they are. */
function Code({ node, children, ...props }: ComponentProps<"code"> & { node?: unknown }) {
  void node
  const inPre = useContext(InPre)
  const directory = useOptionalEngine()?.directory ?? ""
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
  pre: ({ node, ...props }) => {
    void node
    return (
      <InPre.Provider value={true}>
        <CodeBlock {...props} />
      </InPre.Provider>
    )
  },
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
function CodeBlock(props: ComponentProps<"pre">) {
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
