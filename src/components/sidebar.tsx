"use client"

import Link from "next/link"
import { useParams, usePathname, useRouter } from "next/navigation"
import { useMemo, type ReactNode } from "react"
import { useOptionalEngine } from "@/lib/engine-store"
import { fmtRelative } from "@/lib/format"
import { useAllChats, useWorkspaces } from "@/lib/workspaces"
import { useLogs } from "./logs-modal"
import { WorkspaceDot, WorkspaceSwitcher } from "./workspace-switcher"

/**
 * The one sidebar, local and cloud: workspace switcher, every chat from every
 * workspace (colored by workspace), then navigation. `status` and `footer` carry
 * the cloud workspace's sandbox line and controls.
 */
export function Sidebar({ status, footer }: { status?: ReactNode; footer?: ReactNode }) {
  const w = useWorkspaces()
  const engine = useOptionalEngine()
  const params = useParams<{ id?: string; sid?: string }>()
  const router = useRouter()
  const activeChat = w.mode === "cloud" ? params?.sid : params?.id

  const colors = useMemo(() => new Map(w.workspaces?.map((x) => [x.id, x.color]) ?? []), [w.workspaces])
  const names = useMemo(() => new Map(w.workspaces?.map((x) => [x.id, x.name]) ?? []), [w.workspaces])
  const chats = useAllChats()

  async function rename(id: string, current: string) {
    const title = window.prompt("Rename chat", current)
    if (engine && title && title.trim() && title.trim() !== current) await engine.renameSession(id, title.trim())
  }

  async function remove(id: string, title: string) {
    if (!engine || !window.confirm(`Delete "${title || "Untitled"}"? This cannot be undone.`)) return
    await engine.deleteSession(id)
    if (activeChat === id) router.push(w.newChatHref ?? "/")
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-surface-2/60">
      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <Link href="/" className="font-serif text-[1.35rem] font-semibold tracking-tight text-ink">
          syrup
        </Link>
        <div className="flex items-center gap-2">
          {w.mode === "cloud" && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">early access</span>}
          {engine && <span title={engine.connected ? "Connected to engine" : engine.ready ? "Reconnecting…" : "Starting…"} className={`h-2 w-2 rounded-full ${engine.connected ? "bg-ok" : "bg-warn pulse"}`} />}
        </div>
      </div>

      <WorkspaceSwitcher />
      {status}

      <div className="px-3 pb-2">
        {w.newChatHref ? (
          <Link href={w.newChatHref} className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink shadow-card transition hover:border-line-2">
            <span className="text-accent">+</span> New chat
          </Link>
        ) : (
          <div className="flex w-full items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted">Pick a workspace to chat</div>
        )}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Chats</div>
        {w.workspaces && chats.length === 0 && <div className="px-2 py-3 text-sm text-muted">No chats yet.</div>}
        <ul className="space-y-0.5">
          {chats.map((c) => {
            const active = activeChat === c.id
            const mine = c.workspaceId === w.activeId && !!engine?.sessionsLoaded
            const st = mine ? engine!.status[c.id]?.type : undefined
            const busy = st === "busy" || st === "retry"
            return (
              <li key={c.id} className="group relative">
                <Link
                  href={w.chatHref(c)}
                  onClick={() => c.workspaceId !== w.activeId && w.select(c.workspaceId)}
                  title={names.get(c.workspaceId)}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${mine ? "pr-14" : ""} ${active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"}`}
                >
                  <WorkspaceDot color={colors.get(c.workspaceId) ?? 0} />
                  <span className="min-w-0 flex-1 truncate">{c.title || "Untitled"}</span>
                  {busy ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent pulse" /> : <span className={`shrink-0 text-[11px] text-muted ${mine ? "group-hover:hidden" : ""}`}>{fmtRelative(c.updated)}</span>}
                </Link>
                {mine && (
                  <div className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex">
                    <IconBtn title="Rename" onClick={() => void rename(c.id, c.title)}>
                      <path d="M2.5 11.5h9M8.6 2.9l2 2-6.1 6.1H2.5v-2l6.1-6.1Z" />
                    </IconBtn>
                    <IconBtn title="Delete" onClick={() => void remove(c.id, c.title)} danger>
                      <path d="M3 4h8M5.5 4V2.5h3V4M4 4l.6 7.5h4.8L10 4" />
                    </IconBtn>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </nav>

      {footer}
      <BottomNav />
    </aside>
  )
}

function BottomNav() {
  const { mode, user } = useWorkspaces()
  const { open: openLogs } = useLogs()
  const p = usePathname()
  return (
    <>
      <div className="space-y-0.5 border-t border-line p-2">
        <NavLink href="/memory" active={p === "/memory"} icon="memory">
          Memory
        </NavLink>
        <NavLink href="/skills" active={p === "/skills"} icon="skill">
          Skills
        </NavLink>
        <NavLink href="/settings/providers" active={p.startsWith("/settings/providers")} icon="key">
          Providers
        </NavLink>
        <NavLink href="/usage" active={p === "/usage"} icon="chart">
          Usage & cost
        </NavLink>
        {mode === "cloud" && (
          <NavLink href="/settings" active={p === "/settings"} icon="settings">
            Account & privacy
          </NavLink>
        )}
        {user?.admin && (
          <NavLink href="/admin" active={p.startsWith("/admin")} icon="admin">
            Admin
          </NavLink>
        )}
        <button type="button" onClick={openLogs} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-2 transition hover:bg-surface/70 hover:text-ink">
          <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            {ICONS.doc}
          </svg>
          Logs
        </button>
      </div>
      {user && (
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5">
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.image} alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface font-mono text-xs text-ink-2">{(user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()}</span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">{user.name ?? "Signed in"}</div>
              <div className="truncate text-[11px] text-muted">{user.email}</div>
            </div>
          </div>
          <div className="mt-2 flex gap-3 text-[11px] text-muted">
            <Link href="/legal/terms" className="hover:text-ink">
              Terms
            </Link>
            <Link href="/legal/privacy" className="hover:text-ink">
              Privacy
            </Link>
          </div>
        </div>
      )}
    </>
  )
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick(): void; danger?: boolean; children: ReactNode }) {
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

const ICONS: Record<string, ReactNode> = {
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
  settings: (
    <>
      <circle cx="7" cy="7" r="2" />
      <path d="M7 1.5v1.6M7 10.9v1.6M1.5 7h1.6M10.9 7h1.6M3.1 3.1l1.1 1.1M9.8 9.8l1.1 1.1M3.1 10.9l1.1-1.1M9.8 4.2l1.1-1.1" />
    </>
  ),
  admin: <path d="M7 1.5 12 3.5v3.3c0 2.9-2.1 5.1-5 5.7-2.9-.6-5-2.8-5-5.7V3.5L7 1.5Z" />,
  doc: <path d="M3 2.5h8v9H3zM5 5h4M5 7h4M5 9h2.5" />,
}

function NavLink({ href, active, icon, children }: { href: string; active: boolean; icon: keyof typeof ICONS; children: ReactNode }) {
  return (
    <Link href={href} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[icon]}
      </svg>
      {children}
    </Link>
  )
}
