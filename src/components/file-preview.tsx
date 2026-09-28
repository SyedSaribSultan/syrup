"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useEngine } from "@/lib/engine-store"
import { copyText, hostOS, localFileAction, revealLabel, type FileBody } from "@/lib/file-actions"
import { extOf, fmtBytes, parentRel } from "@/lib/fs-rules"
import { highlight, langOf, type Tok } from "@/lib/highlight"
import { inlineHtml, resolveAsset } from "@/lib/html-inline"
import { prefillComposer, usePanel } from "@/lib/panel"
import { useDismiss } from "@/lib/use-dismiss"
import { useNarrow } from "@/lib/use-window-class"
import { absPath, downloadFile, list, read, type Read, type Target } from "@/lib/workspace-fs"
import { Brew } from "./brew"
import { Markdown } from "./markdown"
import { MenuList, Popover, type MenuItem } from "./ui/sheet"

/**
 * Preview tab: one workspace file, rendered by kind. Static only: HTML runs
 * in a sandboxed srcdoc frame (scripts, no same-origin), SVG only ever as an
 * <img>, PDFs in the browser's viewer. Reloads when the agent changes files.
 * Wide content (code, tables) scrolls sideways inside the preview, never the page.
 */

type Kind = "html" | "markdown" | "image" | "pdf" | "csv" | "tsv" | "json" | "code" | "binary"

function kindOf(name: string, body: FileBody): Kind {
  const ext = extOf(name)
  if (ext === "svg") return "image"
  if (body.kind === "binary") return body.mime?.startsWith("image/") ? "image" : body.mime === "application/pdf" || ext === "pdf" ? "pdf" : "binary"
  if (ext === "html" || ext === "htm") return "html"
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown"
  if (ext === "csv") return "csv"
  if (ext === "tsv") return "tsv"
  if (ext === "json" || ext === "jsonc" || ext === "geojson" || ext === "ipynb") return "json"
  return "code"
}

const GUI = /^\s*(?:import|from)\s+(?:tkinter|Tkinter|customtkinter|PyQt[456]|PySide[26]?|pygame|wx|kivy|pyglet|arcade|turtle)\b/m

type Loaded = { rev: number; read: Read; url: string | null } | { rev: number; error: string }

export function FilePreview({ target, rel }: { target: Target; rel: string }) {
  const panel = usePanel()!
  const { onFilesChanged } = useEngine()
  const name = rel.split("/").pop() || rel
  const cloud = !!target.workspaceId
  const [rev, setRev] = useState(0)
  const [res, setRes] = useState<Loaded | null>(null)
  const [source, setSource] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const closeMore = useCallback(() => setMore(false), [])
  useDismiss(moreRef, more, closeMore)
  const narrow = useNarrow()
  // The inlined page HtmlView renders, for "Open in new tab".
  const [page, setPage] = useState<{ rel: string; src: string } | null>(null)

  useEffect(() => {
    let alive = true
    read(target, rel, name).then(
      (r) => {
        if (!alive) return
        const bin = "body" in r && (r.body.kind === "binary" || extOf(name) === "svg") ? r.body : null
        // SVG is shown through <img> from a blob so its scripts never run.
        const url = bin ? URL.createObjectURL(bin.kind === "binary" ? new Blob([bin.bytes], { type: bin.mime || "application/octet-stream" }) : new Blob([bin.text], { type: "image/svg+xml" })) : null
        setRes({ rev, read: r, url })
      },
      async (err: unknown) => {
        // A folder mention without a trailing slash: show it in Files instead.
        const isDir = await list(target, rel, true).then(
          () => true,
          () => false,
        )
        if (!alive) return
        if (isDir) panel.openFile(rel, { folder: true })
        setRes({ rev, error: isDir ? "That's a folder. It's open in Files." : err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, rel, rev])

  const url = res && "url" in res ? res.url : null
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const off = onFilesChanged(() => {
      clearTimeout(t)
      t = setTimeout(() => setRev((r) => r + 1), 900)
    })
    return () => {
      off()
      clearTimeout(t)
    }
  }, [onFilesChanged])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 3000)
    return () => clearTimeout(t)
  }, [note])

  const save = useCallback(async () => {
    setNote(`Fetching ${name}…`)
    try {
      await downloadFile(target, rel, name)
      setNote(`Downloaded ${name}`)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }, [target, rel, name])

  const loaded = res && "read" in res ? res.read : null
  const body = loaded && "body" in loaded ? loaded.body : null
  const kind = body ? kindOf(name, body) : null
  const canToggle = kind === "html" || kind === "markdown" || kind === "csv" || kind === "tsv" || (kind === "image" && extOf(name) === "svg")
  const gui = cloud && body?.kind === "text" && /^pyw?$/.test(extOf(name)) && GUI.test(body.text)

  let content: ReactNode
  if (!res) content = <Center><Brew mood="load" size="md" /></Center>
  else if ("error" in res) content = <Center><span className="text-warn">{res.error}</span></Center>
  else if ("tooBig" in res.read)
    content = (
      <Center>
        <div className="max-w-[320px] space-y-3">
          <div>
            <span className="text-ink">{name}</span> is {fmtBytes(res.read.tooBig)}, too big to preview here.
          </div>
          <PrimaryButton onClick={() => void save()}>Download</PrimaryButton>
        </div>
      </Center>
    )
  else if (body) {
    const text = body.kind === "text" ? body.text : ""
    if (source && canToggle) content = <CodeView text={extOf(name) === "svg" && body.kind === "binary" ? new TextDecoder().decode(body.bytes) : text} name={name} />
    else if (kind === "html") content = <HtmlView html={text} rel={rel} target={target} onNavigate={(r) => panel.openFile(r)} onReady={(src) => setPage({ rel, src })} />
    else if (kind === "markdown")
      content = (
        <div className="overflow-auto px-4 py-4 medium:px-6 medium:py-5">
          <Markdown text={text} />
        </div>
      )
    else if (kind === "image" && url)
      content = (
        <div className="checker flex min-h-full items-center justify-center overflow-auto p-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={name} className="max-h-full max-w-full object-contain shadow-card" />
        </div>
      )
    else if (kind === "pdf" && url) content = <iframe src={url} title={name} className="h-full w-full border-0 bg-surface" />
    else if (kind === "csv" || kind === "tsv") content = <TableView text={text} delimiter={kind === "tsv" ? "\t" : ","} />
    else if (kind === "json") content = <CodeView text={pretty(text)} name="x.json" />
    else if (kind === "code") content = <CodeView text={text} name={name} />
    else
      content = (
        <Center>
          <div className="max-w-[320px] space-y-3">
            <div>No preview for this kind of file.</div>
            <PrimaryButton onClick={() => void save()}>Download</PrimaryButton>
          </div>
        </Center>
      )
  }

  const icon = (d: ReactNode) => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {d}
    </svg>
  )
  const actions: MenuItem[] = [
    { label: "Reload", icon: icon(<path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 2.5v2.8H8.7" />), onSelect: () => setRev((r) => r + 1) },
    ...(narrow && kind === "html" && page?.rel === rel ? [{ label: "Open in new tab", icon: icon(<path d="M8 2.5h3.5V6M11.3 2.7 6.5 7.5M10 8.5v2.3c0 .4-.3.7-.7.7H3.2c-.4 0-.7-.3-.7-.7V4.7c0-.4.3-.7.7-.7h2.3" />), onSelect: () => openInTab(page.src, name) }] : []),
    { label: "Download", icon: icon(<path d="M7 2.5V10M3.8 7 7 10.2 10.2 7M2.5 11.5h9" />), onSelect: () => void save() },
    {
      label: "Copy path",
      icon: icon(
        <>
          <rect x="4.5" y="4.5" width="7" height="7.5" rx="1.5" />
          <path d="M9.5 4.5V3a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
        </>,
      ),
      onSelect: () => {
        void copyText(absPath(target, rel))
        setNote("Copied path")
      },
    },
    ...(cloud
      ? []
      : [
          {
            label: revealLabel(hostOS()),
            icon: icon(<path d="M1.8 11.2V3.4c0-.4.3-.7.7-.7h2.8l1.2 1.3h4.9c.4 0 .7.3.7.7v5.8c0 .4-.3.7-.7.7H2.5c-.4 0-.7-.3-.7-.7Z" />),
            onSelect: () =>
              void localFileAction(target.dir, absPath(target, rel), "reveal").then((err) => {
                if (err) setNote(err === "missing" ? "It isn't there anymore" : err)
              }),
          },
        ]),
  ]

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5 pointer-coarse:py-0.5">
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-[11px] text-ink-2" title={absPath(target, rel)}>
          {rel}
          {loaded && "size" in loaded && <span className="ml-2 text-muted">{fmtBytes(loaded.size)}</span>}
        </span>
        {canToggle && (
          <div className="flex shrink-0 rounded-lg border border-line p-0.5 text-[11px] pointer-coarse:text-[13px]">
            {(["Page", "Source"] as const).map((l) => (
              <button key={l} type="button" aria-pressed={(l === "Source") === source} onClick={() => setSource(l === "Source")} className={`rounded-md px-1.5 py-0.5 transition pointer-coarse:min-h-10 pointer-coarse:px-3 ${(l === "Source") === source ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                {l === "Page" && kind !== "html" ? "View" : l}
              </button>
            ))}
          </div>
        )}
        <div ref={moreRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            aria-expanded={more}
            aria-haspopup="menu"
            aria-label="File actions"
            title="Reload, download, copy path…"
            className={`flex items-center justify-center rounded-lg p-1.5 transition pointer-coarse:h-11 pointer-coarse:w-11 ${more ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"}`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <circle cx="3" cy="7" r="1" />
              <circle cx="7" cy="7" r="1" />
              <circle cx="11" cy="7" r="1" />
            </svg>
          </button>
          <Popover open={more} onClose={closeMore} title={name} className="absolute top-full right-0 z-20 mt-1 w-[220px] rounded-xl border border-line bg-surface shadow-card">
            <MenuList items={actions} onDone={closeMore} />
          </Popover>
        </div>
      </div>
      {gui && <GuiNote name={name} onDownload={() => void save()} />}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">{content}</div>
      {note && (
        <div role="status" className="shrink-0 truncate border-t border-line px-3 py-2 text-[12px] text-ink-2">
          {note}
        </div>
      )}
    </>
  )
}

function GuiNote({ name, onDownload }: { name: string; onDownload(): void }) {
  return (
    <div className="mx-3 mt-3 shrink-0 rounded-xl border border-accent/30 bg-accent-soft/40 px-3.5 py-3 text-[13px] leading-relaxed text-ink-2">
      <div className="font-medium text-ink">This one opens a desktop window.</div>
      <div>
        {name} is a desktop app, and your cloud workspace has no screen to show it on. Download it and run it on your computer, or ask for a version that runs in the browser.
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <PrimaryButton onClick={() => prefillComposer(`Make a web version of ${name} that I can open in the browser: a static index.html (with its CSS and JS next to it) that does the same thing, so I can preview it in the panel.`)}>
          Ask for a web version
        </PrimaryButton>
        <button type="button" onClick={onDownload} className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-ink-2 transition hover:border-line-2 hover:text-ink pointer-coarse:min-h-11 pointer-coarse:px-4 pointer-coarse:text-[13px]">
          Download
        </button>
      </div>
    </div>
  )
}

/**
 * "Open in new tab" for an HTML preview, at real size on a phone. Never a blob: URL (it would run the
 * page's scripts with syrup's origin); a blank tab holding the same sandboxed srcdoc frame instead.
 * Opened synchronously from the tap, or mobile browsers block the popup.
 */
function openInTab(src: string, name: string) {
  const w = window.open("", "_blank")
  if (!w) return
  // Cut the way back to this tab before anything from the page runs.
  w.opener = null
  const d = w.document
  d.title = name
  const meta = d.createElement("meta")
  meta.name = "viewport"
  meta.content = "width=device-width, initial-scale=1"
  d.head.append(meta)
  d.body.style.margin = "0"
  const f = d.createElement("iframe")
  f.setAttribute("sandbox", "allow-scripts allow-forms allow-modals")
  f.title = name
  f.srcdoc = src
  f.style.cssText = "border:0;display:block;width:100vw;height:100vh;height:100dvh;background:#fff"
  d.body.append(f)
}

function HtmlView({ html, rel, target, onNavigate, onReady }: { html: string; rel: string; target: Target; onNavigate(rel: string): void; onReady?(src: string): void }) {
  const [doc, setDoc] = useState<{ src: string; missing: string[]; html: string } | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(onReady)
  useEffect(() => {
    ready.current = onReady
  })

  useEffect(() => {
    let alive = true
    const readAsset = async (r: string) => {
      const got = await read(target, r, r.split("/").pop() || r)
      return "body" in got ? got.body : null
    }
    void inlineHtml(html, rel, readAsset).then((d) => {
      if (!alive) return
      setDoc({ src: d.html, missing: d.missing, html })
      ready.current?.(d.html)
    })
    return () => {
      alive = false
    }
  }, [html, rel, target])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const href = (e.data as { syrupPreviewNav?: unknown } | null)?.syrupPreviewNav
      if (typeof href !== "string") return
      const r = resolveAsset(href.split(/[?#]/)[0], parentRel(rel))
      if (r) onNavigate(r)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [rel, onNavigate])

  if (!doc) return <Center><Brew mood="load" size="md" /></Center>
  return (
    <div className="flex h-full flex-col">
      {doc.missing.length > 0 && (
        <div className="shrink-0 truncate border-b border-line bg-warn/5 px-3 py-1.5 text-[11px] text-ink-2" title={doc.missing.join("\n")}>
          Not found in the workspace: {doc.missing.slice(0, 3).join(", ")}
          {doc.missing.length > 3 ? ` and ${doc.missing.length - 3} more` : ""}
        </div>
      )}
      {/* Scripts run, but in an opaque origin: no access to syrup, its storage or its cookies. */}
      <iframe ref={frame} title={`Preview of ${rel}`} sandbox="allow-scripts allow-forms allow-modals" srcDoc={doc.src} className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  )
}

const MAX_LINES = 20_000
const MAX_HIGHLIGHT_LINES = 5_000

const TOK_CLASS: Record<Tok["t"], string> = { "": "", k: "text-accent", s: "text-ok", c: "text-muted italic", n: "text-warn", tag: "text-accent" }

function CodeView({ text, name }: { text: string; name: string }) {
  const { lines, clipped } = useMemo(() => {
    const all = text.split(/\r?\n/)
    const shown = all.length > MAX_LINES ? all.slice(0, MAX_LINES).join("\n") : text
    return { lines: highlight(shown, all.length > MAX_HIGHLIGHT_LINES ? null : langOf(name)), clipped: all.length > MAX_LINES ? all.length : 0 }
  }, [text, name])
  if (!text) return <Center>Empty file.</Center>
  return (
    <div className="min-w-max py-2 font-mono text-[12px] leading-[1.6]">
      <div className="flex">
        <pre aria-hidden className="sticky left-0 shrink-0 bg-surface pr-3 pl-3 text-right text-muted/70 select-none">
          {lines.map((_, i) => i + 1).join("\n")}
        </pre>
        <pre className="pr-6 text-ink-2">
          {lines.map((toks, i) => (
            <div key={i}>
              {toks.length === 0 || (toks.length === 1 && !toks[0].v)
                ? " "
                : toks.map((t, j) =>
                    t.t ? (
                      <span key={j} className={TOK_CLASS[t.t]}>
                        {t.v}
                      </span>
                    ) : (
                      t.v
                    ),
                  )}
            </div>
          ))}
        </pre>
      </div>
      {clipped > 0 && <div className="px-3 pt-2 font-sans text-[12px] text-muted">Showing the first {MAX_LINES.toLocaleString()} of {clipped.toLocaleString()} lines. Download for the rest.</div>}
    </div>
  )
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

const MAX_ROWS = 1000

/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes. Stops after MAX_ROWS + 1 rows. */
function parseDelimited(text: string, delimiter: string, maxRows = MAX_ROWS + 1): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === "") quoted = true
    else if (c === delimiter) {
      row.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      if (rows.length >= maxRows) return rows
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function TableView({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = useMemo(() => parseDelimited(text, delimiter), [text, delimiter])
  if (rows.length === 0) return <Center>Empty file.</Center>
  const [head, ...body] = rows
  const shown = body.slice(0, MAX_ROWS - 1)
  return (
    <div className="p-3">
      <table className="w-max min-w-full border-collapse text-[12px]">
        <thead className="sticky top-0">
          <tr>
            <th className="border border-line bg-surface-2 px-2 py-1 text-right font-normal text-muted">#</th>
            {head.map((h, i) => (
              <th key={i} className="border border-line bg-surface-2 px-2 py-1 text-left font-medium text-ink">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="even:bg-surface-2/40">
              <td className="border border-line px-2 py-0.5 text-right text-muted tabular-nums">{i + 1}</td>
              {head.map((_, j) => (
                <td key={j} className="max-w-[360px] truncate border border-line px-2 py-0.5 text-ink-2" title={r[j]}>
                  {r[j]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length >= MAX_ROWS - 1 && <div className="pt-2 text-[12px] text-muted">Showing the first {(MAX_ROWS - 1).toLocaleString()} rows.</div>}
    </div>
  )
}

function Center({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-[160px] items-center justify-center p-6 text-center text-[13px] text-muted">{children}</div>
}

function PrimaryButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink transition hover:opacity-90 pointer-coarse:min-h-11 pointer-coarse:px-4 pointer-coarse:text-[13px]">
      {children}
    </button>
  )
}
