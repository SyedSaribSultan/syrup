"use client"

import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { useOptionalEngine } from "@/lib/engine-store"
import { SIDEBAR_SHORTCUT, useNav } from "@/lib/nav"
import { fmtRelative } from "@/lib/format"
import { setTheme, useTheme, type Theme } from "@/lib/theme"
import { useDismiss } from "@/lib/use-dismiss"
import { useAllChats, useWorkspaces } from "@/lib/workspaces"
import { useLogs } from "./logs-modal"
import { confirmDialog, promptDialog } from "./ui/dialog"
import { MenuList, Popover, type MenuItem } from "./ui/sheet"
import { WorkspaceDot, WorkspaceSwitcher, WorkspaceTile } from "./workspace-switcher"

/**
 * The one sidebar, local and cloud: workspace switcher, every chat from every
 * workspace (colored by workspace), then the account row with the settings menu.
 * `status` is the cloud workspace's sandbox line; `footer` its controls, shown
 * inside the workspace switcher's menu.
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
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const shown = q ? chats.filter((c) => (c.title || "Untitled").toLowerCase().includes(q)) : chats
  const nav = useNav()
  // Collapsed by choice: rail on every desktop width. Forced by an open side panel: rail only between 840 and 1199px.
  const rail = !!nav?.collapsed
  const forced = !rail && !!nav?.railForced

  async function rename(id: string, current: string) {
    const title = await promptDialog({ title: "Rename chat", value: current, confirmLabel: "Save" })
    if (engine && title && title !== current) await engine.renameSession(id, title)
  }

  async function remove(id: string, title: string) {
    if (!engine || !(await confirmDialog({ title: `Delete "${title || "Untitled"}"?`, body: "This cannot be undone.", confirmLabel: "Delete", danger: true }))) return
    await engine.deleteSession(id)
    if (activeChat === id) router.push(w.newChatHref ?? "/")
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-line bg-surface-2/60 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {(rail || forced) && <Rail className={rail ? "hidden expanded:flex" : "hidden expanded:max-large:flex"} />}
      <div className={`flex min-h-0 flex-1 flex-col ${rail ? "expanded:hidden" : forced ? "expanded:max-large:hidden" : ""}`}>
      <div className="flex items-center justify-between gap-2 pt-4 pr-2 pb-1 pl-4 pointer-coarse:pt-3">
        <Link href="/" className="font-serif text-[1.35rem] font-semibold tracking-tight text-ink">
          syrup
        </Link>
        <div className="flex items-center gap-2">
          {w.mode === "cloud" && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">early access</span>}
          {engine && <span title={engine.connected ? "Connected to engine" : engine.ready ? "Reconnecting…" : "Starting…"} className={`h-2 w-2 rounded-full ${engine.connected ? "bg-ok" : "bg-warn pulse"}`} />}
          {nav && (
            <>
              <SideBtn label={`Collapse sidebar (${SIDEBAR_SHORTCUT})`} onClick={nav.toggleCollapsed} className="hidden expanded:flex">
                <path d="M5.5 2.5v11M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4Z" />
              </SideBtn>
              <SideBtn label="Close menu" onClick={nav.closeDrawer} className="flex expanded:hidden">
                <path d="M4 4l8 8M12 4l-8 8" />
              </SideBtn>
            </>
          )}
        </div>
      </div>

      <WorkspaceSwitcher controls={footer} />
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
        {chats.length > 6 && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="mx-1 mb-1.5 w-[calc(100%-0.5rem)] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-line-2"
          />
        )}
        {w.workspaces && chats.length === 0 && <div className="px-2 py-3 text-sm text-muted">No chats yet.</div>}
        {query && shown.length === 0 && <div className="px-2 py-3 text-sm text-muted">No chats match.</div>}
        <ul className="space-y-0.5">
          {shown.map((c) => {
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
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition pointer-coarse:py-2.5 ${mine ? "pr-14 pointer-coarse:pr-20" : ""} ${active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"}`}
                >
                  <WorkspaceDot color={colors.get(c.workspaceId) ?? 0} />
                  <span className="min-w-0 flex-1 truncate">{c.title || "Untitled"}</span>
                  {busy ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent pulse" /> : <span className={`shrink-0 text-[11px] text-muted ${mine ? "transition group-focus-within:opacity-0 group-hover:opacity-0 pointer-coarse:hidden" : ""}`}>{fmtRelative(c.updated)}</span>}
                </Link>
                {mine && (
                  <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5 motion-reveal">
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

      <AccountRow />
      </div>
    </aside>
  )
}

/** Header button in the sidebar: collapse (desktop) or close (drawer). `className` sets its display per breakpoint. */
function SideBtn({ label, onClick, className, children }: { label: string; onClick(): void; className: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={`h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11 ${className}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}

/** The collapsed desktop sidebar: expand, new chat, the workspace, then settings. */
function Rail({ className = "" }: { className?: string }) {
  const w = useWorkspaces()
  const nav = useNav()
  const active = w.workspaces?.find((x) => x.id === w.activeId)
  const item = "flex h-10 w-10 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface hover:text-ink"
  const expand = `Expand sidebar (${SIDEBAR_SHORTCUT})`
  return (
    <div className={`h-full flex-col items-center gap-1 py-3 ${className}`}>
      <button type="button" onClick={nav?.toggleCollapsed} aria-label={expand} title={expand} className={item}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5.5 2.5v11M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4Z" />
        </svg>
      </button>
      {w.newChatHref && (
        <Link href={w.newChatHref} aria-label="New chat" title="New chat" className={item}>
          <svg width="16" height="16" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2.5H4A1.5 1.5 0 0 0 2.5 4v9A1.5 1.5 0 0 0 4 14.5h9a1.5 1.5 0 0 0 1.5-1.5V9M12.3 2.2l2.5 2.5L8.5 11H6V8.5l6.3-6.3Z" />
          </svg>
        </Link>
      )}
      {active && (
        <button type="button" onClick={nav?.toggleCollapsed} aria-label={`${active.name}: show chats`} title={`${active.name}: show chats`} className={item}>
          <WorkspaceTile name={active.name} color={active.color} size={24} />
        </button>
      )}
      <span className="flex-1" />
      <SettingsTrigger place="bottom-0 left-full ml-2">
        {(open, toggle) => (
          <button type="button" onClick={toggle} aria-expanded={open} aria-label="Settings" title="Settings" className={item}>
            <Avatar size={26} />
          </button>
        )}
      </SettingsTrigger>
    </div>
  )
}

/**
 * The bottom of the sidebar: who you are and one gear. Memory, Skills, Providers, Usage, Account, Logs,
 * Admin and Theme live in its menu (docs/RESPONSIVE.md §9): a popover on desktop, a bottom sheet on phones.
 */
function AccountRow() {
  const { mode, user } = useWorkspaces()
  return (
    <SettingsTrigger place="bottom-full left-2 mb-1.5">
      {(open, toggle) => (
        <div className="border-t border-line p-2">
          <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-surface/70 pointer-coarse:py-2.5">
            <Avatar size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{user?.name ?? (mode === "local" ? "syrup" : "Signed in")}</span>
              <span className="block truncate text-[11px] text-muted">{user?.email ?? "Running on this computer"}</span>
            </span>
            <svg width="16" height="16" viewBox="0 0 14 14" className="shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-label="Settings">
              {ICONS.settings}
            </svg>
          </button>
        </div>
      )}
    </SettingsTrigger>
  )
}

function Avatar({ size }: { size: number }) {
  const { user } = useWorkspaces()
  if (user?.image)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.image} alt="" width={size} height={size} className="shrink-0 rounded-full" referrerPolicy="no-referrer" />
  const initial = user ? (user.name ?? user.email ?? "?").slice(0, 1).toUpperCase() : "s"
  return (
    <span style={{ width: size, height: size }} className={`flex shrink-0 items-center justify-center rounded-full bg-surface text-xs text-ink-2 shadow-card ${user ? "font-mono" : "font-serif font-semibold text-accent"}`}>
      {initial}
    </span>
  )
}

/** Owns the settings menu's open state and outside-press handling; `place` positions the desktop popover. */
function SettingsTrigger({ place, children }: { place: string; children: (open: boolean, toggle: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  return (
    <div ref={ref} className="relative">
      {children(open, () => setOpen((v) => !v))}
      <SettingsMenu open={open} onClose={close} className={`absolute z-30 w-[260px] overflow-hidden rounded-xl border border-line bg-surface shadow-card ${place}`} />
    </div>
  )
}

function SettingsMenu({ open, onClose, className }: { open: boolean; onClose(): void; className: string }) {
  const { mode, user } = useWorkspaces()
  const { open: openLogs } = useLogs()
  const icon = (name: keyof typeof ICONS) => (
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  )
  const items: MenuItem[] = [
    { label: "Memory", href: "/memory", icon: icon("memory") },
    { label: "Skills", href: "/skills", icon: icon("skill") },
    { label: "Providers", href: "/settings/providers", icon: icon("key") },
    { label: "Usage & cost", href: "/usage", icon: icon("chart") },
    ...(mode === "cloud" ? [{ label: "Account & privacy", href: "/settings", icon: icon("settings") }] : []),
    ...(user?.admin ? [{ label: "Admin", href: "/admin", icon: icon("admin") }] : []),
    { label: "Logs", onSelect: openLogs, icon: icon("doc") },
  ]
  return (
    <Popover open={open} onClose={onClose} title="Settings" className={className}>
      <MenuList items={items} onDone={onClose} />
      <ThemeRow />
      {mode === "cloud" && (
        <div className="flex gap-4 border-t border-line px-4 py-2.5 text-[11px] text-muted max-expanded:pb-4">
          <Link href="/legal/terms" onClick={onClose} className="hover:text-ink">
            Terms
          </Link>
          <Link href="/legal/privacy" onClick={onClose} className="hover:text-ink">
            Privacy
          </Link>
        </div>
      )}
    </Popover>
  )
}

/** System / Light / Dark, applied instantly and remembered on this device. */
function ThemeRow() {
  const theme = useTheme()
  const opts: [Theme, string][] = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ]
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 max-expanded:py-3.5">
      <span className="text-[13px] text-ink max-expanded:text-[15px]">Theme</span>
      <div role="radiogroup" aria-label="Theme" className="flex rounded-lg bg-surface-2 p-0.5">
        {opts.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            onClick={() => setTheme(value)}
            className={`rounded-md px-2.5 py-1 text-[12px] transition pointer-coarse:px-3 pointer-coarse:py-2 ${theme === value ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
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
      className={`rounded p-1 text-muted transition hover:bg-surface-2 pointer-coarse:p-2 ${danger ? "hover:text-err" : "hover:text-ink"}`}
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
