"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { readRecent, useEngine } from "@/lib/engine-store"

type Browse = { path: string; exists: boolean; git?: boolean; parent: string | null; dirs: { name: string; path: string; git: boolean }[]; home?: string }

function base(p: string) {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function WorkspaceSwitcher() {
  const { directory, projects, defaultDirectory, setDirectory } = useEngine()
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>([])

  // Recent = folders chosen here, plus git projects the engine knows. Computed when the menu opens.
  function toggle() {
    if (!open) {
      const fromEngine = projects.map((p) => p.worktree).filter((w) => w && w !== "/" && w !== "\\")
      setRecent([...new Set([...readRecent(), defaultDirectory, ...fromEngine].filter(Boolean))])
    }
    setOpen((v) => !v)
  }
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  function choose(p: string) {
    setDirectory(p)
    setOpen(false)
    router.push("/")
  }

  return (
    <div ref={ref} className="relative px-3 pb-2">
      <button
        type="button"
        onClick={toggle}
        title={directory}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-2 transition hover:bg-surface/70 hover:text-ink"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 opacity-70">
          <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h2.5l1.5 1.5H11A1.5 1.5 0 0 1 12.5 6v4.5A1.5 1.5 0 0 1 11 12H3a1.5 1.5 0 0 1-1.5-1.5v-6Z" />
        </svg>
        <span className="min-w-0 flex-1 truncate font-medium">{directory ? base(directory) : "…"}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0 opacity-60">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full z-30 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          <Picker current={directory} projects={recent} onChoose={choose} />
        </div>
      )}
    </div>
  )
}

function Picker({ current, projects, onChoose }: { current: string; projects: string[]; onChoose(p: string): void }) {
  const [browsing, setBrowsing] = useState(false)
  const [data, setData] = useState<Browse | null>(null)
  const [typed, setTyped] = useState("")
  const [picking, setPicking] = useState(false)
  const [pickErr, setPickErr] = useState<string | null>(null)

  // Native OS dialog on the machine syrup runs on. Falls back to the in-app browser.
  async function pickNative() {
    setPicking(true)
    setPickErr(null)
    try {
      const r = await fetch("/api/workspace/pick", { method: "POST" })
      const j = await r.json()
      if (j.path) onChoose(j.path)
      else if (j.cancelled) return
      else {
        setPickErr(j.error ?? "Could not open a folder dialog")
        setBrowsing(true)
      }
    } catch {
      setPickErr("Could not open a folder dialog")
      setBrowsing(true)
    } finally {
      setPicking(false)
    }
  }

  useEffect(() => {
    if (!browsing) return
    let alive = true
    fetch(`/api/workspace?path=${encodeURIComponent(typed || current)}`)
      .then((r) => r.json())
      .then((j: Browse) => alive && setData(j))
    return () => {
      alive = false
    }
  }, [browsing, typed, current])

  const recent = [...new Set(projects)].filter((p) => p !== current).slice(0, 8)

  if (!browsing) {
    return (
      <div className="py-1">
        <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Workspace</div>
        <div className="truncate px-3 pb-2 font-mono text-[11px] text-ink-2" title={current}>
          {current}
        </div>
        {recent.length > 0 && (
          <>
            <div className="px-3 pt-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Recent</div>
            {recent.map((p) => (
              <button key={p} type="button" onClick={() => onChoose(p)} title={p} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink-2 transition hover:bg-surface-2 hover:text-ink">
                <span className="truncate">{base(p)}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{p}</span>
              </button>
            ))}
          </>
        )}
        <div className="border-t border-line p-1.5">
          <button type="button" onClick={() => void pickNative()} disabled={picking} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-accent transition hover:bg-surface-2 disabled:opacity-60">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0">
              <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h2.5l1.5 1.5H11A1.5 1.5 0 0 1 12.5 6v4.5A1.5 1.5 0 0 1 11 12H3a1.5 1.5 0 0 1-1.5-1.5v-6Z" />
            </svg>
            {picking ? "Waiting for the folder dialog…" : "Open another folder…"}
          </button>
          <button type="button" onClick={() => setBrowsing(true)} className="w-full rounded-lg px-2 py-1 text-left text-[11px] text-muted transition hover:bg-surface-2 hover:text-ink">
            or type / browse a path
          </button>
          {pickErr && <div className="px-2 pt-1 text-[11px] text-warn">{pickErr}</div>}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-line p-1.5">
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && data?.exists && onChoose(data.path)}
          placeholder={data?.path ?? "Type a path…"}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 font-mono text-[12px] outline-none placeholder:text-muted"
        />
      </div>
      <div className="max-h-[260px] overflow-y-auto py-1">
        {data?.parent && (
          <button type="button" onClick={() => setTyped(data.parent!)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] text-ink-2 hover:bg-surface-2">
            <span className="text-muted">↑</span> ..
          </button>
        )}
        {data && !data.exists && <div className="px-3 py-2 text-[12px] text-err">Folder not found.</div>}
        {data?.dirs.map((d) => (
          <button key={d.path} type="button" onClick={() => setTyped(d.path)} onDoubleClick={() => onChoose(d.path)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink">
            <span className="truncate">{d.name}</span>
            {d.git && <span className="rounded bg-surface-2 px-1 text-[10px] text-muted">git</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line p-1.5">
        <button type="button" onClick={() => setBrowsing(false)} className="rounded-lg px-2 py-1 text-[12px] text-muted hover:text-ink">
          Back
        </button>
        <button
          type="button"
          disabled={!data?.exists}
          onClick={() => data && onChoose(data.path)}
          className="rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-40"
        >
          Use {data ? base(data.path) : ""}
        </button>
      </div>
    </div>
  )
}
