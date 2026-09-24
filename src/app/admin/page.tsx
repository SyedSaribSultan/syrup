"use client"

import { useCallback, useEffect, useState } from "react"

type Invite = { id: string; email: string; note: string | null; invitedBy: string | null; createdAt: string; acceptedAt: string | null; revokedAt: string | null }
type User = { id: string; email: string; name: string | null; createdAt: string; lastSeenAt: string | null; analyticsOptOut: boolean; keys: number; research: boolean }
type Req = { id: string; user_id: string; type: string; status: string; requested_at: string }
type Box = { workspaceId: string; workspace: string; email: string; status: string; region: string; engineVersion: string | null; lastSessionStartedAt: string | null; totalSessionSeconds: number; totalCpuMs: number; lastError: string | null }
type Pool = { sandboxes: Box[]; running: number; totalCpuMs: number; totalSessionSeconds: number; cpuBudgetMs: number }

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—")

export default function AdminPage() {
  const [invites, setInvites] = useState<Invite[]>([])
  const [envInvites, setEnvInvites] = useState<string[]>([])
  const [admins, setAdmins] = useState<string[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [requests, setRequests] = useState<Req[]>([])
  const [pool, setPool] = useState<Pool | null>(null)
  const [email, setEmail] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([fetch("/api/admin/invites", { cache: "no-store" }), fetch("/api/admin/users", { cache: "no-store" }), fetch("/api/admin/sandboxes", { cache: "no-store" })])
    if (c.ok) setPool(await c.json())
    if (a.ok) {
      const j = await a.json()
      setInvites(j.invites)
      setEnvInvites(j.envInvites)
      setAdmins(j.adminEmails)
    }
    if (b.ok) {
      const j = await b.json()
      setUsers(j.users)
      setRequests(j.openRequests)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  async function add() {
    setBusy(true)
    setError(null)
    const r = await fetch("/api/admin/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, note }) })
    if (!r.ok) setError((await r.json()).error ?? "failed")
    else {
      setEmail("")
      setNote("")
      await load()
    }
    setBusy(false)
  }

  async function revoke(id: string) {
    await fetch(`/api/admin/invites?id=${id}`, { method: "DELETE" })
    await load()
  }

  const open = invites.filter((i) => !i.revokedAt)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-6 py-8">
        <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink">Admin</h1>
        <p className="mt-1 text-sm text-muted">
          Invites decide who can sign in. Admins: <span className="font-mono text-ink-2">{admins.join(", ") || "—"}</span>
          {envInvites.length > 0 && (
            <>
              {" "}
              · env invites: <span className="font-mono text-ink-2">{envInvites.join(", ")}</span>
            </>
          )}
        </p>

        <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
          <h2 className="text-sm font-medium text-ink">Invite someone</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} placeholder="person@gmail.com" className="min-w-[240px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted focus:border-line-2" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" className="min-w-[200px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[13px] outline-none placeholder:text-muted focus:border-line-2" />
            <button type="button" onClick={() => void add()} disabled={busy || !email.includes("@")} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink disabled:opacity-40">
              {busy ? "Adding…" : "Add invite"}
            </button>
          </div>
          {error && <div className="mt-2 text-xs text-err">{error}</div>}
          <ul className="mt-4 divide-y divide-line">
            {open.length === 0 && <li className="py-3 text-sm text-muted">No open invites.</li>}
            {open.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-mono text-ink">{i.email}</span>
                <span className="text-muted">{i.note}</span>
                <span className={`rounded px-1.5 text-[10px] ${i.acceptedAt ? "bg-surface-2 text-ok" : "bg-surface-2 text-ink-2"}`}>{i.acceptedAt ? "accepted" : "pending"}</span>
                <button type="button" onClick={() => void revoke(i.id)} className="text-xs text-muted hover:text-err">
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
          <h2 className="text-sm font-medium text-ink">
            Users <span className="font-normal text-muted">· {users.length}</span>
          </h2>
          <table className="mt-3 w-full text-[13px]">
            <thead className="text-left text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="py-1 font-medium">Email</th>
                <th className="py-1 font-medium">Joined</th>
                <th className="py-1 font-medium">Last seen</th>
                <th className="py-1 font-medium">Keys</th>
                <th className="py-1 font-medium">Analytics</th>
                <th className="py-1 font-medium">Research</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-2 font-mono text-ink">{u.email}</td>
                  <td className="py-2 text-ink-2">{fmt(u.createdAt)}</td>
                  <td className="py-2 text-ink-2">{fmt(u.lastSeenAt)}</td>
                  <td className="py-2 text-ink-2">{u.keys}</td>
                  <td className="py-2 text-ink-2">{u.analyticsOptOut ? "opted out" : "on"}</td>
                  <td className="py-2 text-ink-2">{u.research ? "consented" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
          <h2 className="text-sm font-medium text-ink">
            Sandboxes <span className="font-normal text-muted">· {pool ? `${pool.running} running · ${(pool.totalCpuMs / 60_000).toFixed(1)} CPU-min used of ${pool.cpuBudgetMs / 60_000} this plan · ${Math.round(pool.totalSessionSeconds / 60)} session-min` : "…"}</span>
          </h2>
          <p className="mt-1 text-xs text-muted">Free plan: 5 active-CPU hours per month, 10 concurrent. Informational; nothing is enforced. Vercel&apos;s own dashboard has the authoritative monthly numbers.</p>
          <table className="mt-3 w-full text-[13px]">
            <thead className="text-left text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="py-1 font-medium">Workspace</th>
                <th className="py-1 font-medium">User</th>
                <th className="py-1 font-medium">Status</th>
                <th className="py-1 font-medium">CPU</th>
                <th className="py-1 font-medium">Sessions</th>
                <th className="py-1 font-medium">Last start</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pool?.sandboxes.map((b) => (
                <tr key={b.workspaceId}>
                  <td className="py-2 text-ink">{b.workspace}</td>
                  <td className="py-2 font-mono text-ink-2">{b.email}</td>
                  <td className={`py-2 ${b.status === "running" ? "text-ok" : b.status === "error" ? "text-err" : "text-ink-2"}`} title={b.lastError ?? ""}>{b.status}</td>
                  <td className="py-2 text-ink-2">{(b.totalCpuMs / 1000).toFixed(0)} s</td>
                  <td className="py-2 text-ink-2">{Math.round(b.totalSessionSeconds / 60)} min</td>
                  <td className="py-2 text-ink-2">{fmt(b.lastSessionStartedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
          <h2 className="text-sm font-medium text-ink">
            Open data requests <span className="font-normal text-muted">· {requests.length}</span>
          </h2>
          <p className="mt-1 text-xs text-muted">Export within 30 days, deletion within 30 days (Privacy Policy §6). Automated fulfilment lands in Phase 3; until then handle these by hand.</p>
          <ul className="mt-3 divide-y divide-line">
            {requests.length === 0 && <li className="py-3 text-sm text-muted">None.</li>}
            {requests.map((r) => {
              const u = users.find((x) => x.id === r.user_id)
              return (
                <li key={r.id} className="flex items-center gap-3 py-2 text-[13px]">
                  <span className="rounded bg-surface-2 px-1.5 text-[10px] uppercase text-ink-2">{r.type}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-ink">{u?.email ?? r.user_id}</span>
                  <span className="text-muted">{fmt(r.requested_at)}</span>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </div>
  )
}
