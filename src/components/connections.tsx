"use client"

import { useCallback, useEffect, useState } from "react"
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
    <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
      <h2 className="text-sm font-medium text-ink">Connections</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
        A GitHub token lets you create workspaces from <em>private</em> repositories. Use a{" "}
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
          fine-grained token
        </a>{" "}
        with <span className="font-mono text-[12px]">Contents: Read</span> on the repositories you want. It is encrypted with a key unique to your account, used only while cloning, and never written to a workspace&apos;s disk.
      </p>
      {state?.connected ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ok">connected</span>
          <span className="min-w-0 font-mono break-all text-ink-2">GitHub token {state.hint}</span>
          <button type="button" disabled={busy} onClick={() => void remove()} className="text-xs text-muted hover:text-err disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-1">
            Remove
          </button>
        </div>
      ) : (
        // Phones: Save goes full width under the field.
        <div className="mt-3 flex flex-col gap-2 medium:flex-row">
          <input value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} placeholder="github_pat_… or ghp_…" type="password" autoComplete="off" className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted focus:border-line-2 pointer-coarse:min-h-11" />
          <button type="button" onClick={() => void save()} disabled={busy || token.trim().length < 20} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink disabled:opacity-40 pointer-coarse:min-h-11">
            {busy ? "Checking…" : "Save"}
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-xs text-err">{error}</div>}
    </section>
  )
}
