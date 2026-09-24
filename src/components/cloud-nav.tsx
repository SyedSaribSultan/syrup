"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

const ICONS: Record<string, ReactNode> = {
  home: <path d="M2 7 7 2.5 12 7v5H8.5V9h-3v3H2V7Z" />,
  folder: <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.2 1.5h3.3A1.5 1.5 0 0 1 12 6v4.5A1.5 1.5 0 0 1 10.5 12h-7A1.5 1.5 0 0 1 2 10.5v-6Z" />,
  key: (
    <>
      <circle cx="5" cy="9" r="3" />
      <path d="M7.2 6.8 12 2M10 4l2 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="7" cy="7" r="2" />
      <path d="M7 1.5v1.6M7 10.9v1.6M1.5 7h1.6M10.9 7h1.6M3.1 3.1l1.1 1.1M9.8 9.8l1.1 1.1M3.1 10.9l1.1-1.1M9.8 4.2l1.1-1.1" />
    </>
  ),
  admin: <path d="M7 1.5 12 3.5v3.3c0 2.9-2.1 5.1-5 5.7-2.9-.6-5-2.8-5-5.7V3.5L7 1.5Z" />,
  doc: <path d="M3 2.5h8v9H3zM5 5h4M5 7h4M5 9h2.5" />,
}

function Item({ href, icon, children, active }: { href: string; icon: keyof typeof ICONS; children: ReactNode; active: boolean }) {
  return (
    <Link href={href} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${active ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-surface/70 hover:text-ink"}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[icon]}
      </svg>
      {children}
    </Link>
  )
}

export function CloudNav({ admin }: { admin: boolean }) {
  const p = usePathname()
  return (
    <nav className="flex min-h-0 flex-1 flex-col px-2">
      <div className="space-y-0.5">
        <Item href="/" icon="home" active={p === "/"}>
          Home
        </Item>
        <Item href="/workspaces" icon="folder" active={p.startsWith("/workspaces") || p.startsWith("/w/")}>
          Workspaces
        </Item>
        <Item href="/settings/providers" icon="key" active={p.startsWith("/settings/providers")}>
          Providers
        </Item>
        <Item href="/settings" icon="settings" active={p === "/settings"}>
          Account & privacy
        </Item>
        {admin && (
          <Item href="/admin" icon="admin" active={p.startsWith("/admin")}>
            Admin
          </Item>
        )}
      </div>
      <div className="mt-auto space-y-0.5 pb-2">
        <div className="px-2 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Legal</div>
        <Item href="/legal/terms" icon="doc" active={p === "/legal/terms"}>
          Terms
        </Item>
        <Item href="/legal/privacy" icon="doc" active={p === "/legal/privacy"}>
          Privacy
        </Item>
      </div>
    </nav>
  )
}
