"use client"

import { useState } from "react"

/**
 * Per-workspace network allow-list. Empty = open internet (private networks
 * always blocked). Any host listed switches the sandbox to strict mode: only
 * providers, git, package registries, syrup, and these hosts.
 */
export function EgressEditor({ workspaceId, initial }: { workspaceId: string; initial: string[] }) {
  const [hosts, setHosts] = useState(initial)
  const [draft, setDraft] = useState("")
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: string[]) {
    setBusy(true)
    setError(null)
    const r = await fetch(`/api/workspaces/${workspaceId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ egressAllow: next }) })
    const j = await r.json()
    if (!r.ok) setError(j.error ?? "Could not save")
    else {
      setHosts(j.egressAllow)
      setDraft("")
    }
    setBusy(false)
  }

  return (
    <div className="border-t border-line px-3 py-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between text-[11px] font-medium uppercase tracking-wider text-muted hover:text-ink">
        <span>Network</span>
        <span>{hosts.length ? `strict · ${hosts.length}` : "open"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] leading-relaxed text-muted">{hosts.length ? "Strict: the agent can only reach your providers, git, package registries, syrup, and the hosts below." : "Open: the agent can reach the internet. Private networks are always blocked. Add a host to switch to strict mode."}</p>
          {hosts.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {hosts.map((h) => (
                <li key={h} className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                  {h}
                  <button type="button" disabled={busy} onClick={() => void save(hosts.filter((x) => x !== h))} className="text-muted hover:text-err" title="Remove">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-1">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && draft.trim() && void save([...hosts, draft])} placeholder="api.example.com" className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] outline-none placeholder:font-sans placeholder:text-muted focus:border-line-2" />
            <button type="button" disabled={busy || !draft.trim()} onClick={() => void save([...hosts, draft])} className="rounded-md bg-surface px-2 py-1 text-[11px] text-ink disabled:opacity-40">
              Add
            </button>
          </div>
          {error && <div className="text-[11px] text-err">{error}</div>}
        </div>
      )}
    </div>
  )
}
