"use client"

import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { useOptionalEngine } from "@/lib/engine-store"
import { SIDEBAR_SHORTCUT, useNav } from "@/lib/nav"
import { fmtRelative } from "@/lib/format"
import { setTheme, useTheme, type Theme } from "@/lib/theme"
import { useDismiss } from "@/lib/use-dismiss"
import { useOverlay } from "@/lib/use-presence"
import { useAllChats, useWorkspaces } from "@/lib/workspaces"
import { useLogs } from "./logs-modal"
import { confirmDialog, promptDialog } from "./ui/dialog"
import { btnClass, Button, Icon, IconButton, LinkButton } from "./ui/s"
import { MenuList, Popover, type MenuItem, type Side } from "./ui/sheet"
import { WorkspaceDot, WorkspaceSwitcher } from "./workspace-switcher"

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
    // The Sarib sidebar (s-sidebar, DESIGN.md §11.2): P0 band, no border, p12, sections 24 apart. syrup's AppShell owns the
    // drawer below its `expanded` breakpoint, so the library's own <1025px drawer is off (--static). In that drawer the
    // band takes the drawer colour the library gives it (fill-secondary-variant): applied here only because syrup's
    // drawer breakpoint (840, docs/RESPONSIVE.md) differs from the library's (1025). overflow-visible: the workspace
    // and settings popovers are wider than the column and must not be clipped; the chat list scrolls on its own.
    <aside aria-label="Sidebar" className="flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {(rail || forced) && <Rail className={rail ? "hidden expanded:flex" : "hidden expanded:max-large:flex"} />}
      <div className={`s-sidebar s-sidebar--static h-auto min-h-0 w-full flex-1 overflow-visible max-expanded:bg-surface ${rail ? "expanded:hidden" : forced ? "expanded:max-large:hidden" : ""}`}>
        <div className="s-sidebar__head">
          <Link href="/" className="s-sidebar__brand">
            syrup
          </Link>
          <div className="flex items-center gap-2">
            {w.mode === "cloud" && <span className="s-badge">Early access</span>}
            {engine && (
              <span
                role="img"
                aria-label={engine.connected ? "Connected to engine" : engine.ready ? "Reconnecting" : "Starting"}
                title={engine.connected ? "Connected to engine" : engine.ready ? "Reconnecting…" : "Starting…"}
                className={`s-dot ${engine.connected ? "s-dot--success" : "s-dot--warning pulse"}`}
              />
            )}
            {nav && (
              <>
                <IconButton icon="panel-close" label={`Collapse sidebar (${SIDEBAR_SHORTCUT})`} aria-expanded onClick={nav.toggleCollapsed} className="max-expanded:hidden" />
                <IconButton icon="close" label="Close menu" onClick={nav.closeDrawer} className="expanded:hidden" />
              </>
            )}
          </div>
        </div>

        {w.newChatHref ? (
          <LinkButton href={w.newChatHref} variant="secondary" block icon="plus">
            New chat
          </LinkButton>
        ) : (
          <Button variant="secondary" block disabled>
            Pick a workspace to chat
          </Button>
        )}

        <div className="flex flex-col gap-1">
          <WorkspaceSwitcher controls={footer} />
          {status}
        </div>

        <nav aria-label="Chats" className="s-sidebar__section -mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
          <p className="s-sidebar__label">Chats</p>
          {chats.length > 6 && (
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="s-search mb-2 w-full min-w-0 max-w-none shrink-0" />
          )}
          {w.workspaces && chats.length === 0 && <p className="s-empty-line px-4 py-2">No chats yet. Start one with New chat.</p>}
          {query && shown.length === 0 && <p className="s-empty-line px-4 py-2">No chats match. Try another word.</p>}
          <ul className="s-rows">
            {shown.map((c) => {
              const active = activeChat === c.id
              const mine = c.workspaceId === w.activeId && !!engine?.sessionsLoaded
              const st = mine ? engine!.status[c.id]?.type : undefined
              const busy = st === "busy" || st === "retry"
              return (
                <li key={c.id} className="s-row-item group">
                  <Link
                    href={w.chatHref(c)}
                    onClick={() => c.workspaceId !== w.activeId && w.select(c.workspaceId)}
                    title={names.get(c.workspaceId)}
                    aria-current={active ? "page" : undefined}
                    // Room for the row's actions while they show (hover or focus; always on touch), so they never cover the title.
                    className={`s-row pointer-coarse:min-h-11 ${mine ? "group-focus-within:pr-20 group-hover:pr-20 pointer-coarse:pr-24" : ""}`}
                  >
                    <WorkspaceDot color={colors.get(c.workspaceId) ?? 0} />
                    <span className="s-row__title flex-1">{c.title || "Untitled"}</span>
                    {busy ? (
                      <span className="s-spinner" role="img" aria-label="Working">
                        <Icon name="loader-circle" />
                      </span>
                    ) : (
                      <span className={`s-row__time ${mine ? "motion-fade group-focus-within:opacity-0 group-hover:opacity-0 pointer-coarse:hidden" : ""}`}>{fmtRelative(c.updated)}</span>
                    )}
                  </Link>
                  {mine && (
                    <div className="s-row__actions motion-reveal">
                      <IconButton icon="edit" label="Rename" onClick={() => void rename(c.id, c.title)} />
                      <IconButton icon="trash-2" label="Delete" onClick={() => void remove(c.id, c.title)} />
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

/** The collapsed desktop sidebar (s-sidebar--rail, 64 wide): expand, new chat, the workspace, then settings. Ghost md icon buttons. */
function Rail({ className = "" }: { className?: string }) {
  const w = useWorkspaces()
  const nav = useNav()
  const active = w.workspaces?.find((x) => x.id === w.activeId)
  const expand = `Expand sidebar (${SIDEBAR_SHORTCUT})`
  return (
    <nav aria-label="Sidebar" className={`s-sidebar s-sidebar--static s-sidebar--rail h-full ${className}`}>
      <div className="s-sidebar__head">
        <IconButton icon="panel-open" size="md" label={expand} aria-expanded={false} onClick={nav?.toggleCollapsed} />
      </div>
      {w.newChatHref && <LinkButton href={w.newChatHref} variant="ghost" icon="plus" label="New chat" />}
      {active && (
        <button type="button" onClick={nav?.toggleCollapsed} aria-label={`${active.name}: show chats`} title={`${active.name}: show chats`} className={btnClass({ variant: "ghost" }, true)}>
          <span className="s-avatar s-avatar--sm">{active.name.slice(0, 1).toUpperCase()}</span>
        </button>
      )}
      <span className="flex-1" />
      <SettingsTrigger place="bottom-0 left-full ml-2" side="right">
        {(open, toggle) => (
          <button type="button" onClick={toggle} aria-expanded={open} aria-label="Settings" title="Settings" className={btnClass({ variant: "ghost" }, true)}>
            <Avatar small />
          </button>
        )}
      </SettingsTrigger>
    </nav>
  )
}

/**
 * The bottom of the sidebar: who you are (a B9 lg row) and one gear. Memory, Skills, Providers, Usage, Account, Logs,
 * Admin and Theme live in its menu (docs/RESPONSIVE.md §9): a popover on desktop, a bottom sheet on phones.
 */
function AccountRow() {
  const { mode, user } = useWorkspaces()
  return (
    <SettingsTrigger place="bottom-full left-0 mb-2" side="up">
      {(open, toggle) => (
        <div className="s-sidebar__foot">
          <button type="button" onClick={toggle} aria-expanded={open} className="s-row s-row--lg">
            <Avatar />
            <span className="s-row__text">
              <span className="s-row__title">{user?.name ?? (mode === "local" ? "syrup" : "Signed in")}</span>
              <span className="s-row__sub">{user?.email ?? "Running on this computer"}</span>
            </span>
          </button>
          <IconButton icon="settings" label="Settings" aria-expanded={open} onClick={toggle} />
        </div>
      )}
    </SettingsTrigger>
  )
}

/** s-avatar: 32 (md) in the account row, 24 (sm) in the rail. A photo gets the inset hairline; else the initial. */
function Avatar({ small }: { small?: boolean }) {
  const { user } = useWorkspaces()
  const size = small ? "s-avatar--sm" : "s-avatar--md"
  if (user?.image)
    return (
      <span className={`s-avatar ${size}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={user.image} alt="" referrerPolicy="no-referrer" />
      </span>
    )
  return <span className={`s-avatar ${size}`}>{user ? (user.name ?? user.email ?? "?").slice(0, 1).toUpperCase() : "s"}</span>
}

/** Owns the settings menu's open state and outside-press handling; `place` positions the desktop popover, `side` says where that is. */
function SettingsTrigger({ place, side, children }: { place: string; side: Side; children: (open: boolean, toggle: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  return (
    <div ref={ref} className="relative">
      {children(open, () => setOpen((v) => !v))}
      <SettingsMenu open={open} onClose={close} side={side} className={`s-raised s-raised--md absolute z-dropdown w-[260px] overflow-hidden ${place}`} />
    </div>
  )
}

function SettingsMenu({ open, onClose, side, className }: { open: boolean; onClose(): void; side: Side; className: string }) {
  const { mode, user } = useWorkspaces()
  const { open: openLogs } = useLogs()
  const items: MenuItem[] = [
    { label: "Memory", href: "/memory", icon: <Icon name="file-text" /> },
    { label: "Skills", href: "/skills", icon: <Icon name="sparkle" /> },
    { label: "Providers", href: "/settings/providers", icon: <Icon name="lock" /> },
    { label: "Usage & cost", href: "/usage", icon: <Icon name="chart-column" /> },
    ...(mode === "cloud" ? [{ label: "Account & privacy", href: "/settings", icon: <Icon name="user" /> }] : []),
    ...(user?.admin ? [{ label: "Admin", href: "/admin", icon: <Icon name="shell" /> }] : []),
    { label: "Logs", onSelect: openLogs, icon: <Icon name="list" /> },
  ]
  return (
    <Popover open={open} onClose={onClose} title="Settings" side={side} className={className}>
      <MenuList items={items} onDone={onClose} />
      <ThemeRow />
      {mode === "cloud" && <LegalLinks onDone={onClose} />}
    </Popover>
  )
}

/** Terms and Privacy under the settings menu. They navigate, so the menu closes without its exit (docs/MOTION.md §4.3). */
function LegalLinks({ onDone }: { onDone(): void }) {
  const overlay = useOverlay()
  const go = () => {
    overlay?.skipExit()
    onDone()
  }
  return (
    <div className="flex gap-5 border-t border-line px-4 py-3 max-expanded:pb-4">
      <Link href="/legal/terms" onClick={go} className="s-btn s-btn--link-neutral s-btn--sm">
        Terms
      </Link>
      <Link href="/legal/privacy" onClick={go} className="s-btn s-btn--link-neutral s-btn--sm">
        Privacy
      </Link>
    </div>
  )
}

/** System / Light / Dark (s-seg), applied instantly and remembered on this device. */
function ThemeRow() {
  const theme = useTheme()
  const opts: [Theme, string][] = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ]
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 max-expanded:py-3">
      <span className="text-sm text-ink">Theme</span>
      <div role="group" aria-label="Theme" className="s-seg">
        {opts.map(([value, label]) => (
          <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)} className="s-seg__item">
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
