"use client"

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react"
import { ModelPicker } from "./model-picker"

export type Attachment = { name: string; mime: string; url: string; size: number }

type Props = {
  onSend(text: string, files: Attachment[]): Promise<void> | void
  onStop?(): void
  busy?: boolean
  autoFocus?: boolean
  placeholder?: string
}

const MAX_BYTES = 10 * 1024 * 1024

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function Composer({ onSend, onStop, busy, autoFocus, placeholder }: Props) {
  const [text, setText] = useState("")
  const [files, setFiles] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [warn, setWarn] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  // Grow with content, up to a cap.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  async function addFiles(list: FileList | File[] | null) {
    if (!list) return
    setWarn(null)
    const next: Attachment[] = []
    for (const f of Array.from(list)) {
      if (f.size > MAX_BYTES) {
        setWarn(`${f.name} is over 10 MB and was skipped.`)
        continue
      }
      next.push({ name: f.name || `pasted.${(f.type.split("/")[1] ?? "bin").replace("+xml", "")}`, mime: f.type || "application/octet-stream", url: await readAsDataUrl(f), size: f.size })
    }
    setFiles((prev) => [...prev, ...next].slice(0, 8))
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData.files)
    if (items.length > 0) {
      e.preventDefault()
      void addFiles(items)
    }
  }

  async function submit() {
    const t = text.trim()
    if ((!t && files.length === 0) || sending) return
    setSending(true)
    try {
      await onSend(t, files)
      setText("")
      setFiles([])
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
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {files.map((f, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-lg border border-line bg-bg px-2 py-1 text-xs text-ink-2">
              {f.mime.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.url} alt="" className="h-5 w-5 rounded object-cover" />
              ) : (
                <span>📎</span>
              )}
              <span className="max-w-[160px] truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-ink">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        rows={1}
        placeholder={placeholder ?? "Ask syrup to build, fix, or explain something…"}
        className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-6 text-ink outline-none placeholder:text-muted"
      />
      <div className="flex items-center justify-between px-2 pb-2">
        <div className="flex items-center gap-1">
          <ModelPicker />
          <input ref={picker} type="file" multiple hidden accept="image/*,application/pdf,text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.go,.rs,.java,.c,.cpp,.h,.css,.html,.yaml,.yml,.toml" onChange={(e) => void addFiles(e.target.files)} />
          <button type="button" title="Attach files (or paste an image)" aria-label="Attach files" onClick={() => picker.current?.click()} className="rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.8 4.2 4.6 8.4a1.6 1.6 0 0 0 2.3 2.3l4.6-4.6a3 3 0 0 0-4.2-4.2L2.6 6.6a4.2 4.2 0 0 0 6 6l3.1-3.1" />
            </svg>
          </button>
          {warn && <span className="text-[11px] text-warn">{warn}</span>}
        </div>
        {busy ? (
          <button type="button" onClick={onStop} className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-ink-2 transition hover:border-line-2 hover:text-ink">
            <span className="h-2 w-2 rounded-[2px] bg-current" /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={(!text.trim() && files.length === 0) || sending}
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
