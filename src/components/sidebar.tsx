"use client"

import Link from "next/link"
import { useParams, usePathname, useRouter } from "next/navigation"
import { useMemo } from "react"
import { useEngine } from "@/lib/engine-store"
import { fmtRelative } from "@/lib/format"
import { useLogs } from "./logs-modal"
import { WorkspaceSwitcher } from "./workspace-switcher"

export function Sidebar() {
  const { sessions, sessionsLoaded, status, connected, renameSession, deleteSession } = useEngine()
  const { open: openLogs } = useLogs()
  const params = useParams<{ id?: string }>()
  const pathname = usePathname()
  const router = useRouter()

  const list = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => !s.parentID)
        .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
    [sessions],
  )

  async function rename(id: string, current: string) {
    const title = window.prompt("Rename chat", current)
    if (title && title.trim() && title.trim() !== current) await renameSession(id, title.trim())
  }

  async function remove(id: string, title: string) {
    if (!window.confirm(`Delete "${title || "Untitled"}"? This cannot be undone.`)) return
    await deleteSession(id)
    if (params?.id === id) router.push("/")
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-surface-2/60">
      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <Link href="/" className="font-serif text-[1.35rem] font-semibold tracking-tight text-ink">
          syrup
        </Link>
        <span title={connected ? "Connected to engine" : "Reconnecting…"} className={`h-2 w-2 rounded-full ${connected ? "bg-ok" : "bg-warn pulse"}`} />
      </div>

      <WorkspaceSwitcher />

      <div className="px-3 pb-2">
        <Link href="/" className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink shadow-card transition hover:border-line-2">
          <span className="text-accent">+</span> New chat
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Recent</div>
        {sessionsLoaded && list.length === 0 && <div className="px-2 py-3 text-sm text-muted">No chats in this workspace yet.</div>}
        <ul className="space-y-0.5">
          {list.map((s) => {
            const active = params?.id === s.id
            const busy = status[s.id]?.type === "busy" || status[s.id]?.type === "retry"
            return (
              <li key={s.id} className="group relative">
                <Link
                  href={`/s/${s.id}`}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 pr-14 text-sm transition ${
                    active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                  {busy ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent pulse" />
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted group-hover:hidden">{fmtRelative(s.time.updated ?? s.time.created)}</span>
                  )}
                </Link>
                <div className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex">
                  <IconBtn title="Rename" onClick={() => void rename(s.id, s.title ?? "")}>
                    <path d="M2.5 11.5h9M8.6 2.9l2 2-6.1 6.1H2.5v-2l6.1-6.1Z" />
                  </IconBtn>
                  <IconBtn title="Delete" onClick={() => void remove(s.id, s.title ?? "")} danger>
                    <path d="M3 4h8M5.5 4V2.5h3V4M4 4l.6 7.5h4.8L10 4" />
                  </IconBtn>
                </div>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="space-y-0.5 border-t border-line p-2">
        <NavLink href="/memory" active={pathname === "/memory"} icon="memory">
          Memory
        </NavLink>
        <NavLink href="/skills" active={pathname === "/skills"} icon="skill">
          Skills
        </NavLink>
        <NavLink href="/settings/providers" active={pathname === "/settings/providers"} icon="key">
          Providers
        </NavLink>
        <NavLink href="/usage" active={pathname === "/usage"} icon="chart">
          Usage & cost
        </NavLink>
        <button type="button" onClick={openLogs} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-2 transition hover:bg-surface/70 hover:text-ink">
          <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2.5h8v9H3zM5 5h4M5 7h4M5 9h2.5" />
          </svg>
          Logs
        </button>
      </div>
    </aside>
  )
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick(): void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.preventDefault()
        onClick()
      }}
      className={`rounded p-1 text-muted transition hover:bg-surface-2 ${danger ? "hover:text-err" : "hover:text-ink"}`}
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}

const ICONS: Record<string, React.ReactNode> = {
  key: (
    <>
      <circle cx="5" cy="9" r="3" />
      <path d="M7.2 6.8 12 2M10 4l2 2" />
    </>
  ),
  chart: <path d="M2 12h10M3.5 10V6M7 10V3M10.5 10V7.5" />,
  memory: (
    <>
      <path d="M4 2.5h6a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 10 11.5H4A1.5 1.5 0 0 1 2.5 10V4A1.5 1.5 0 0 1 4 2.5Z" />
      <path d="M5 5.5h4M5 8h2.5" />
    </>
  ),
  skill: <path d="M7 1.5 8.6 5l3.6.4-2.7 2.4.8 3.6L7 9.6l-3.3 1.8.8-3.6L1.8 5.4 5.4 5 7 1.5Z" />,
}

function NavLink({ href, active, icon, children }: { href: string; active: boolean; icon: keyof typeof ICONS; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
        active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[icon]}
      </svg>
      {children}
    </Link>
  )
}
