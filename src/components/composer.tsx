"use client"

import { Button, Icon, IconButton } from "./ui/s"
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react"
import { PREFILL_EVENT } from "@/lib/panel"
import { useDismiss } from "@/lib/use-dismiss"
import { useOverlay } from "@/lib/use-presence"
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
  /** Keeps the typed text in sessionStorage under this key until it is sent, so leaving the page does not lose it. */
  draftKey?: string
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
export function Composer({ onSend, onStop, busy, autoFocus, placeholder, draftKey }: Props) {
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

  // The draft survives leaving the page: restored on arrival, saved as it changes, dropped once sent.
  const restored = useRef(false)
  useEffect(() => {
    if (!draftKey) return
    let saved: string | null = null
    try {
      saved = sessionStorage.getItem(draftKey)
    } catch {}
    const t = setTimeout(() => {
      restored.current = true
      if (saved) setText((cur) => cur || saved)
    }, 0)
    return () => clearTimeout(t)
  }, [draftKey])
  useEffect(() => {
    if (!draftKey || !restored.current) return
    try {
      if (text) sessionStorage.setItem(draftKey, text)
      else sessionStorage.removeItem(draftKey)
    } catch {}
  }, [draftKey, text])

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
    <div className="rounded-3xl border border-line bg-bg transition focus-within:border-line-2">
      {files.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-3 pt-3">
          {files.map((f, i) => (
            <span key={i} className="s-chip s-chip--removable">
              {f.mime.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.url} alt="" className="s-chip__media" />
              ) : (
                <Icon name="file" />
              )}
              <span className="s-chip__label max-w-[160px]">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="s-chip__remove">
                <Icon name="x" />
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
        className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-base leading-6 text-ink outline-none placeholder:text-muted"
      />
      {/* Attach, Stop and Send are one matched set of library buttons at md (32 at app scale); the library gives each its 44 touch floor. */}
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          <AttachMenu onFiles={(l) => void addFiles(l)} />
          <div className="hidden min-w-0 expanded:block">
            <ModelPicker />
          </div>
          {warn && <span className="truncate text-2xs text-warn">{warn}</span>}
        </div>
        {busy ? (
          <Button variant="outline" pill onClick={onStop} className="shrink-0">
            <span aria-hidden="true" className="mr-1.5 inline-block size-2 rounded-[2px] bg-current align-middle" />
            Stop
          </Button>
        ) : (
          <IconButton variant="brand" size="md" pill icon="arrow-up" label="Send" onClick={() => void submit()} disabled={empty || sending} className="shrink-0" />
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
      <IconButton size="md" icon="plus" label="Add photos and files" title="Add photos and files (or paste an image)" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" />
      <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={take} />
      <input ref={photos} type="file" hidden multiple accept="image/*" onChange={take} />
      <input ref={files} type="file" hidden multiple accept={FILE_TYPES} onChange={take} />
      <Popover open={open} onClose={close} label="Add photos and files" side="up" className="s-raised s-raised--md absolute bottom-full left-0 z-dropdown mb-2 w-[300px] p-2">
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

/** Each tile hands over to the native file picker or camera, so the menu closes without its exit (docs/MOTION.md §4.3). */
function Tile({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  const overlay = useOverlay()
  return (
    <button
      type="button"
      onClick={() => {
        overlay?.skipExit()
        onClick()
      }}
      // Concentric inside the r16 raised popover (p8): r10 tiles on the muted fill.
      className="flex flex-1 flex-col items-center gap-2 rounded-md bg-surface-2 px-2 py-3.5 text-sm text-ink-2 transition hover:text-ink max-expanded:py-5"
    >
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
      {label}
    </button>
  )
}
