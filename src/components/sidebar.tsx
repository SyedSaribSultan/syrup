"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { useMemo } from "react"
import { useEngine } from "@/lib/engine-store"
import { fmtRelative } from "@/lib/format"

export function Sidebar() {
  const { sessions, status, connected } = useEngine()
  const params = useParams<{ id?: string }>()
  const pathname = usePathname()

  const list = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => !s.parentID)
        .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
    [sessions],
  )

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-surface-2/60">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <Link href="/" className="font-serif text-[1.35rem] font-semibold tracking-tight text-ink">
          syrup
        </Link>
        <span
          title={connected ? "Connected to engine" : "Reconnecting…"}
          className={`h-2 w-2 rounded-full ${connected ? "bg-ok" : "bg-warn pulse"}`}
        />
      </div>

      <div className="px-3 pb-2">
        <Link
          href="/"
          className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink shadow-card transition hover:border-line-2"
        >
          <span className="text-accent">+</span> New chat
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Recent</div>
        {list.length === 0 && <div className="px-2 py-3 text-sm text-muted">No chats yet.</div>}
        <ul className="space-y-0.5">
          {list.map((s) => {
            const active = params?.id === s.id
            const busy = status[s.id]?.type === "busy" || status[s.id]?.type === "retry"
            return (
              <li key={s.id}>
                <Link
                  href={`/s/${s.id}`}
                  className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
                    active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                  {busy ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent pulse" />
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted opacity-0 transition group-hover:opacity-100">
                      {fmtRelative(s.time.updated ?? s.time.created)}
                    </span>
                  )}
                </Link>
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
      </div>
    </aside>
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
  skill: (
    <>
      <path d="M7 1.5 8.6 5l3.6.4-2.7 2.4.8 3.6L7 9.6l-3.3 1.8.8-3.6L1.8 5.4 5.4 5 7 1.5Z" />
    </>
  ),
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
