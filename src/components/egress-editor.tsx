"use client"

import { useState } from "react"
import { Button, Icon } from "./ui/s"

/** The allow-list entry that opts into open internet (src/server/engine/egress.ts OPEN_INTERNET). */
const OPEN = "*"

/**
 * Per-workspace network allow-list. Strict by default: only git, package
 * registries, syrup, and the hosts listed. Open internet is an explicit
 * opt-in, stored as "*" in the list. Private networks are always blocked.
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

  const openNet = hosts.includes(OPEN)
  const listed = hosts.filter((h) => h !== OPEN)

  // Lives in the workspace menu (a raised surface): the disclosure is a menu item, the controls the Sarib check, badge and sm field.
  return (
    <div className="flex flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="s-menu__item">
        <span className="s-menu__text">Network</span>
        <span className="s-menu__shortcut">{openNet ? "Open" : listed.length ? `Strict · ${listed.length}` : "Strict"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
          <p className="s-help">{openNet ? "Open: the agent can reach the internet. Private networks are always blocked." : "Strict: the agent can only reach git, package registries, web search, syrup, and the hosts below."}</p>
          <label className="s-check">
            <input type="checkbox" checked={openNet} disabled={busy} onChange={(e) => void save(e.target.checked ? [...listed, OPEN] : listed)} />
            Allow the open internet
          </label>
          {listed.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {listed.map((h) => (
                <li key={h} className="s-badge gap-1 font-mono">
                  {h}
                  <button type="button" disabled={busy} onClick={() => void save(hosts.filter((x) => x !== h))} aria-label={`Remove ${h}`} data-s-tip="Remove" className="inline-flex text-muted hover:text-ink">
                    <Icon name="x" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <div className="s-field s-field--sm min-w-0 flex-1">
              <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && draft.trim() && void save([...hosts, draft])} placeholder="api.example.com" aria-label="Host to allow" className="s-field__input" />
            </div>
            <Button variant="secondary" size="sm" disabled={busy || !draft.trim()} onClick={() => void save([...hosts, draft])}>
              Add
            </Button>
          </div>
          {error && <p className="s-field-error">{error}</p>}
        </div>
      )}
    </div>
  )
}
