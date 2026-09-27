"use client"

import { createContext, memo, useContext, type ComponentProps } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { useOptionalEngine } from "@/lib/engine-store"
import { filePathIn } from "@/lib/file-actions"
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
        <pre {...props} />
      </InPre.Provider>
    )
  },
  code: Code,
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
