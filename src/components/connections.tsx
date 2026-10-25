"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "./ui/s"
import { confirmDialog } from "./ui/dialog"

/** Settings card: GitHub token for private repositories. */
export function Connections() {
  const [state, setState] = useState<{ connected: boolean; hint: string | null } | null>(null)
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch("/api/me/github", { cache: "no-store" })
    if (r.ok) setState(await r.json())
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  async function save() {
    setBusy(true)
    setError(null)
    const r = await fetch("/api/me/github", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
    const j = await r.json()
    if (!r.ok) setError(j.error ?? "Could not save token")
    else {
      setToken("")
      setState(j)
    }
    setBusy(false)
  }

  async function remove() {
    if (!(await confirmDialog({ title: "Remove the GitHub token?", body: "Existing workspaces keep their files; new private-repo workspaces will need a token again.", confirmLabel: "Remove", danger: true }))) return
    setBusy(true)
    await fetch("/api/me/github", { method: "DELETE" })
    await load()
    setBusy(false)
  }

  return (
    <section className="s-settings__group mt-6">
      <div className="s-settings__head">
        <h2 className="s-settings__title">Connections</h2>
        <p className="s-settings__desc">
          A GitHub token lets you create workspaces from <em>private</em> repositories. Use a{" "}
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="s-link">
            fine-grained token
          </a>{" "}
          with <code className="s-code">Contents: Read</code> on the repositories you want. It is encrypted with a key unique to your account, used only while cloning, and never written to a workspace&apos;s disk.
        </p>
      </div>
      {state?.connected ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="s-badge s-badge--success">Connected</span>
          <span className="min-w-0 font-mono break-all text-ink-2">GitHub token {state.hint}</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      ) : (
        // Phones: Save goes full width under the field.
        <div className="flex flex-col gap-2 medium:flex-row">
          <div className="s-field min-w-0 flex-1">
            <input value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} placeholder="github_pat_… or ghp_…" type="password" autoComplete="off" aria-label="GitHub token" aria-invalid={error ? true : undefined} className="s-field__input font-mono" />
          </div>
          <Button busy={busy} disabled={token.trim().length < 20} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
      {error && <p className="s-field-error">{error}</p>}
    </section>
  )
}
