"use client"

import { useCallback, useEffect, useState } from "react"
import { Insights } from "@/components/admin-insights"
import { alertDialog, confirmDialog } from "@/components/ui/dialog"
import { Button } from "@/components/ui/s"

type User = { id: string; email: string; name: string | null; createdAt: string; lastSeenAt: string | null; blockedAt: string | null; analyticsOptOut: boolean; keys: number; research: boolean }
type Req = { id: string; user_id: string; type: string; status: string; requested_at: string }
type Box = { workspaceId: string; workspace: string; email: string; status: string; region: string; engineVersion: string | null; lastSessionStartedAt: string | null; totalSessionSeconds: number; totalCpuMs: number; lastError: string | null }
type Pool = { sandboxes: Box[]; running: number; totalCpuMs: number; totalSessionSeconds: number; cpuBudgetMs: number }

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "Never")
/** s-table, dense: cells keep to one line; the wrapper scrolls sideways on narrow screens. */
const TABLE = "whitespace-nowrap"

export default function AdminPage() {
  const [admins, setAdmins] = useState<string[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [requests, setRequests] = useState<Req[]>([])
  const [pool, setPool] = useState<Pool | null>(null)

  const load = useCallback(async () => {
    const [b, c] = await Promise.all([fetch("/api/admin/users", { cache: "no-store" }), fetch("/api/admin/sandboxes", { cache: "no-store" })])
    if (c.ok) setPool(await c.json())
    if (b.ok) {
      const j = await b.json()
      setUsers(j.users)
      setRequests(j.openRequests)
      setAdmins(j.adminEmails)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  async function setBlocked(u: User, blocked: boolean) {
    if (blocked && !(await confirmDialog({ title: `Block ${u.email}?`, body: "They can't sign in or use syrup until you unblock them, and their running sandboxes stop now.", confirmLabel: "Block", danger: true }))) return
    const r = await fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: u.id, blocked }) })
    if (!r.ok) await alertDialog({ title: "That didn't work", body: (await r.json().catch(() => null))?.error })
    await load()
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-4 py-8 medium:px-6">
        <h1 className="font-display text-heading text-ink">Admin</h1>
        <p className="mt-2 text-base text-ink-2">
          Anyone with a verified Google account can sign in. Admins: <span className="font-mono text-ink-2">{admins.join(", ") || "none set"}</span>
        </p>

        <Insights />

        <section className="s-card mt-6">
          <h2 className="flex flex-wrap items-baseline gap-x-2 text-lg text-ink">
            Users <span className="s-meta">{users.length}</span>
          </h2>
          {/* Tables scroll sideways inside their card on narrow screens instead of widening the page. */}
          <div className="s-table s-table--dense">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Joined</th>
                  <th>Last seen</th>
                  <th>Keys</th>
                  <th>Analytics</th>
                  <th>Research</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="font-mono text-ink">{u.email}</td>
                    <td className="text-ink-2">{fmt(u.createdAt)}</td>
                    <td className="text-ink-2">{fmt(u.lastSeenAt)}</td>
                    <td className="text-ink-2">{u.keys}</td>
                    <td className="text-ink-2">{u.analyticsOptOut ? "Opted out" : "On"}</td>
                    <td className="text-ink-2">{u.research ? "Consented" : "None"}</td>
                    <td className="text-right">
                      {admins.includes(u.email) ? (
                        <span className="s-badge">Admin</span>
                      ) : u.blockedAt ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="s-badge s-badge--critical" title={`Blocked ${fmt(u.blockedAt)}`}>
                            Blocked
                          </span>
                          <Button variant="secondary" size="sm" onClick={() => void setBlocked(u, false)}>
                            Unblock
                          </Button>
                        </span>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => void setBlocked(u, true)}>
                          Block
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="s-card mt-6">
          <h2 className="flex flex-wrap items-baseline gap-x-2 text-lg text-ink">
            Sandboxes <span className="s-meta">{pool ? `${pool.running} running · ${(pool.totalCpuMs / 60_000).toFixed(1)} CPU-min used of ${pool.cpuBudgetMs / 60_000} this plan · ${Math.round(pool.totalSessionSeconds / 60)} session-min` : "…"}</span>
          </h2>
          <p className="s-help">Free plan: 5 active-CPU hours per month, 10 concurrent. Informational; nothing is enforced. Vercel&apos;s own dashboard has the authoritative monthly numbers.</p>
          <div className="s-table s-table--dense">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>User</th>
                  <th>Status</th>
                  <th>CPU</th>
                  <th>Sessions</th>
                  <th>Last start</th>
                </tr>
              </thead>
              <tbody>
                {pool?.sandboxes.map((b) => (
                  <tr key={b.workspaceId}>
                    <td className="text-ink">{b.workspace}</td>
                    <td className="font-mono text-ink-2">{b.email}</td>
                    <td title={b.lastError ?? ""}>
                      <span className={`s-badge ${b.status === "running" ? "s-badge--success" : b.status === "error" ? "s-badge--critical" : ""}`}>{b.status}</span>
                    </td>
                    <td className="text-ink-2">{(b.totalCpuMs / 1000).toFixed(0)} s</td>
                    <td className="text-ink-2">{Math.round(b.totalSessionSeconds / 60)} min</td>
                    <td className="text-ink-2">{fmt(b.lastSessionStartedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="s-card mt-6">
          <h2 className="flex flex-wrap items-baseline gap-x-2 text-lg text-ink">
            Open data requests <span className="s-meta">{requests.length}</span>
          </h2>
          <p className="s-help">Export within 30 days, deletion within 30 days (Privacy Policy §6). Automated fulfilment lands in Phase 3; until then handle these by hand.</p>
          <ul className="s-rows s-rows--divided">
            {requests.length === 0 && <li className="s-empty-line py-3">No open requests.</li>}
            {requests.map((r) => {
              const u = users.find((x) => x.id === r.user_id)
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-sm">
                  <span className="s-badge">{r.type}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-ink">{u?.email ?? r.user_id}</span>
                  <span className="s-meta">{fmt(r.requested_at)}</span>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </div>
  )
}
