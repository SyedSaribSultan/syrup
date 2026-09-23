import type { Session } from "next-auth"
import Link from "next/link"
import type { ReactNode } from "react"
import { Analytics } from "./analytics"
import { CloudNav } from "./cloud-nav"
import { LogsProvider } from "./logs-modal"

/**
 * Cloud-mode frame: no engine connection, a smaller sidebar, and the signed-in
 * account at the bottom. Public pages (sign-in, legal) render without the sidebar.
 */
export function CloudShell({ session, children }: { session: Session | null; children: ReactNode }) {
  const user = session?.user
  return (
    <LogsProvider>
      <Analytics user={user ? { id: user.id, admin: user.admin } : null} />
      {user ? (
        <div className="flex h-full">
          <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-surface-2/60">
            <div className="flex items-center justify-between px-4 pt-4 pb-3">
              <Link href="/" className="font-serif text-[1.35rem] font-semibold tracking-tight text-ink">
                syrup
              </Link>
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">early access</span>
            </div>
            <CloudNav admin={user.admin} />
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
                <Link href="/settings" title="Account and privacy" className="rounded p-1 text-muted transition hover:bg-surface hover:text-ink">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="7" cy="7" r="2" />
                    <path d="M7 1.5v1.6M7 10.9v1.6M1.5 7h1.6M10.9 7h1.6M3.1 3.1l1.1 1.1M9.8 9.8l1.1 1.1M3.1 10.9l1.1-1.1M9.8 4.2l1.1-1.1" />
                  </svg>
                </Link>
              </div>
            </div>
          </aside>
          <main className="relative flex min-w-0 flex-1 flex-col">{children}</main>
        </div>
      ) : (
        <main className="flex h-full min-w-0 flex-col">{children}</main>
      )}
    </LogsProvider>
  )
}
