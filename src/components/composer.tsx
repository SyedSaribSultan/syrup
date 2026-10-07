"use client"

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react"
import { PREFILL_EVENT } from "@/lib/panel"
import { useDismiss } from "@/lib/use-dismiss"
import { useCoarsePointer } from "@/lib/use-window-class"
import { ModelPicker } from "./model-picker"
import { Popover } from "./ui/sheet"

export type Attachment = { name: string; mime: string; url: string; size: number }

type Props = {
  onSend(text: string, files: Attachment[]): Promise<void> | void
  onStop?(): void
  busy?: boolean
  autoFocus?: boolean
  placeholder?: string
}

const MAX_BYTES = 10 * 1024 * 1024
const FILE_TYPES = "image/*,application/pdf,text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.go,.rs,.java,.c,.cpp,.h,.css,.html,.yaml,.yml,.toml"

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/**
 * The message box. On touch screens (docs/RESPONSIVE.md §5.3) Enter adds a new line and the send button
 * sends, the keyboard doesn't pop up on arrival, and the model picker lives in the top bar instead
 * (below the expanded breakpoint).
 */
export function Composer({ onSend, onStop, busy, autoFocus, placeholder }: Props) {
  const [text, setText] = useState("")
  const [files, setFiles] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [warn, setWarn] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const coarse = useCoarsePointer()

  // Focus on arrival with a mouse and keyboard only; on a phone it would throw the keyboard over the screen.
  useEffect(() => {
    if (autoFocus && !window.matchMedia("(pointer: coarse)").matches) ta.current?.focus()
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Text handed over from elsewhere (the Files panel's "ask for a web version").
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const t = (e as CustomEvent<string>).detail
      if (typeof t !== "string") return
      setText(t)
      requestAnimationFrame(() => {
        const el = ta.current
        if (!el) return
        el.focus()
        el.setSelectionRange(t.length, t.length)
      })
    }
    window.addEventListener(PREFILL_EVENT, onPrefill)
    return () => window.removeEventListener(PREFILL_EVENT, onPrefill)
  }, [])

  // Grow with content, up to a cap (lower on phones, where the keyboard already takes half the screen).
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(el.scrollHeight, coarse ? 144 : 240)}px`
  }, [text, coarse])

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
    } catch {
      // The caller shows the error; the draft stays in the box so nothing typed is lost.
    } finally {
      setSending(false)
      // Keep typing on desktop; on a phone put the keyboard away so the answer is visible.
      if (window.matchMedia("(pointer: coarse)").matches) ta.current?.blur()
      else ta.current?.focus()
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (coarse) return
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const empty = !text.trim() && files.length === 0

  return (
    <div className="rounded-3xl border border-line bg-surface shadow-card transition focus-within:border-line-2 expanded:rounded-2xl">
      {files.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-3 pt-3">
          {files.map((f, i) => (
            <span key={i} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-bg px-2 py-1 text-xs text-ink-2">
              {f.mime.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.url} alt="" className="h-5 w-5 rounded object-cover" />
              ) : (
                <span>📎</span>
              )}
              <span className="max-w-[160px] truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-ink pointer-coarse:-my-2 pointer-coarse:px-2 pointer-coarse:py-2">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        data-composer
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        rows={1}
        enterKeyHint={coarse ? "enter" : "send"}
        placeholder={placeholder ?? "Ask syrup to build, fix, or explain something…"}
        className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-6 text-ink outline-none placeholder:text-muted"
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          <AttachMenu onFiles={(l) => void addFiles(l)} />
          <div className="hidden min-w-0 expanded:block">
            <ModelPicker />
          </div>
          {warn && <span className="truncate text-[11px] text-warn">{warn}</span>}
        </div>
        {busy ? (
          <button type="button" onClick={onStop} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-ink-2 transition hover:border-line-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:rounded-full pointer-coarse:px-4">
            <span className="h-2 w-2 rounded-[2px] bg-current" /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={empty || sending}
            aria-label="Send"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink transition disabled:opacity-30 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:rounded-full"
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

/** "+": camera (touch screens), photos, files. A popover above the composer on desktop, a sheet on phones. */
function AttachMenu({ onFiles }: { onFiles(list: FileList | null): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const coarse = useCoarsePointer()
  const camera = useRef<HTMLInputElement>(null)
  const photos = useRef<HTMLInputElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)

  const pick = (input: HTMLInputElement | null) => {
    close()
    input?.click()
  }
  const take = (e: ChangeEvent<HTMLInputElement>) => {
    onFiles(e.target.files)
    e.target.value = ""
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Add photos and files"
        title="Add photos and files (or paste an image)"
        className={`flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:rounded-full ${open ? "bg-surface-2 text-ink" : ""}`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={take} />
      <input ref={photos} type="file" hidden multiple accept="image/*" onChange={take} />
      <input ref={files} type="file" hidden multiple accept={FILE_TYPES} onChange={take} />
      <Popover open={open} onClose={close} label="Add photos and files" className="absolute bottom-full left-0 z-30 mb-2 w-[300px] rounded-2xl border border-line bg-surface p-2 shadow-card">
        <div className="flex gap-2 px-2 pb-3 max-expanded:px-4 expanded:p-0">
          {coarse && (
            <Tile label="Camera" onClick={() => pick(camera.current)}>
              <path d="M2.5 6A1.5 1.5 0 0 1 4 4.5h1.6l1-1.5h2.8l1 1.5H12A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5V6Z" />
              <circle cx="8" cy="8.5" r="2.3" />
            </Tile>
          )}
          <Tile label="Photos" onClick={() => pick(photos.current)}>
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
            <path d="m2.8 11 3.2-3.2 2.5 2.5 1.6-1.6 3.1 3.1" />
            <circle cx="10.5" cy="5.8" r="1" />
          </Tile>
          <Tile label="Files" onClick={() => pick(files.current)}>
            <path d="M9.8 4.8 5.3 9.3a1.6 1.6 0 0 0 2.3 2.3l4.7-4.7a3 3 0 0 0-4.2-4.2L3.4 7.4a4.2 4.2 0 0 0 6 6l3.1-3.1" />
          </Tile>
        </div>
      </Popover>
    </div>
  )
}

function Tile({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-1 flex-col items-center gap-1.5 rounded-2xl bg-surface-2 px-2 py-3.5 text-[12px] text-ink-2 transition hover:text-ink max-expanded:py-5 max-expanded:text-[14px]">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
      {label}
    </button>
  )
}
