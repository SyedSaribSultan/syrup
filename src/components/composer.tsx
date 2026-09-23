"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { ModelPicker } from "./model-picker"

type Props = {
  onSend(text: string): Promise<void> | void
  onStop?(): void
  busy?: boolean
  autoFocus?: boolean
  placeholder?: string
}

export function Composer({ onSend, onStop, busy, autoFocus, placeholder }: Props) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  // Grow with content, up to a cap.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  async function submit() {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    try {
      await onSend(t)
      setText("")
    } finally {
      setSending(false)
      ta.current?.focus()
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-surface shadow-card transition focus-within:border-line-2">
      <textarea
        ref={ta}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={1}
        placeholder={placeholder ?? "Ask syrup to build, fix, or explain something…"}
        className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-6 text-ink outline-none placeholder:text-muted"
      />
      <div className="flex items-center justify-between px-2 pb-2">
        <ModelPicker />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-ink-2 transition hover:border-line-2 hover:text-ink"
          >
            <span className="h-2 w-2 rounded-[2px] bg-current" /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!text.trim() || sending}
            aria-label="Send"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink transition disabled:opacity-30"
          >
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path d="M7 12V2M3 6l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
