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

      <div className="border-t border-line p-2">
        <Link
          href="/usage"
          className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
            pathname === "/usage" ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"
          }`}
        >
          <span className="inline-block h-3.5 w-3.5 rounded-sm border border-current opacity-70" />
          Usage & cost
        </Link>
      </div>
    </aside>
  )
}
