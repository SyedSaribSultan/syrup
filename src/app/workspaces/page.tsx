"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"

type Ws = {
  id: string
  name: string
  source: "git" | "empty"
  repoUrl: string | null
  createdAt: string
  lastOpenedAt: string | null
  sandbox: { status: string; lastError: string | null; totalSessionSeconds: number; engineVersion: string | null } | null
}

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "never")

export default function WorkspacesPage() {
  const [list, setList] = useState<Ws[] | null>(null)
  const [repo, setRepo] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch("/api/workspaces", { cache: "no-store" })
    if (r.ok) setList((await r.json()).workspaces)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  async function create(empty = false) {
    setBusy(true)
    setError(null)
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(empty ? { name: name || "Scratch" } : { repoUrl: repo, name }) })
    const j = await r.json()
    if (!r.ok) setError(j.error ?? "Could not create workspace")
    else {
      setRepo("")
      setName("")
      await load()
    }
    setBusy(false)
  }

  async function remove(w: Ws) {
    if (!window.confirm(`Delete "${w.name}"? The sandbox, its files and its snapshots are destroyed. Chat history stays in your account.`)) return
    await fetch(`/api/workspaces/${w.id}`, { method: "DELETE" })
    await load()
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-6 py-8">
        <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink">Workspaces</h1>
        <p className="mt-1 max-w-[640px] text-sm text-muted">A workspace is a repository the agent works in, inside its own isolated sandbox. It sleeps when you leave and wakes when you come back, files intact.</p>

        <div className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="text-sm font-medium text-ink">New workspace</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && repo && void create()} placeholder="https://github.com/owner/repo  or  owner/repo" className="min-w-[280px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted focus:border-line-2" />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (optional)" className="w-[180px] rounded-lg border border-line bg-bg px-3 py-2 text-[13px] outline-none placeholder:text-muted focus:border-line-2" />
            <button type="button" onClick={() => void create()} disabled={busy || repo.trim().length < 3} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink disabled:opacity-40">
              {busy ? "Creating…" : "Create from repo"}
            </button>
            <button type="button" onClick={() => void create(true)} disabled={busy} className="rounded-lg border border-line bg-bg px-3 py-2 text-xs font-medium text-ink disabled:opacity-40">
              Empty workspace
            </button>
          </div>
          <div className="mt-2 text-[11px] text-muted">Public repositories on GitHub, GitLab, Bitbucket or Codeberg. Private repositories come next.</div>
          {error && <div className="mt-2 text-xs text-err">{error}</div>}
        </div>

        <h2 className="mt-8 mb-3 text-sm font-medium text-ink">
          Yours <span className="font-normal text-muted">· {list?.length ?? "…"}</span>
        </h2>
        {list && list.length === 0 && <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">No workspaces yet. Create one above.</div>}
        <ul className="space-y-2">
          {list?.map((w) => (
            <li key={w.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
              <span className={`h-2 w-2 shrink-0 rounded-full ${w.sandbox?.status === "running" ? "bg-ok" : w.sandbox?.status === "error" ? "bg-err" : "bg-line-2"}`} title={w.sandbox?.status ?? "new"} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link href={`/w/${w.id}`} className="truncate text-sm font-medium text-ink hover:underline">
                    {w.name}
                  </Link>
                  <span className="rounded bg-surface-2 px-1 text-[10px] text-ink-2">{w.source}</span>
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted">
                  {w.repoUrl ?? "empty folder"} · opened {fmt(w.lastOpenedAt)}
                  {w.sandbox?.totalSessionSeconds ? ` · ${Math.round(w.sandbox.totalSessionSeconds / 60)} min used` : ""}
                </div>
                {w.sandbox?.lastError && <div className="mt-1 truncate text-[12px] text-err">{w.sandbox.lastError}</div>}
              </div>
              <Link href={`/w/${w.id}`} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink">
                Open
              </Link>
              <button type="button" onClick={() => void remove(w)} className="rounded-lg px-2 py-1.5 text-xs text-muted hover:text-err">
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
