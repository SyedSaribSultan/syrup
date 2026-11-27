import type { Session } from "next-auth"
import type { ReactNode } from "react"
import { NavProvider } from "@/lib/nav"
import { CloudWorkspacesProvider } from "@/lib/workspaces"
import { Analytics } from "./analytics"
import { CloudFrame } from "./cloud-frame"
import { LogsProvider } from "./logs-modal"
import { Sidebar } from "./sidebar"

/** Syrup closes on 11 Dec 2026 (sunset, d-006). Shown on every signed-in page until then. */
function ClosingNotice() {
  return (
    <div className="s-alert s-alert--warning shrink-0 rounded-none px-4 py-2" role="status">
      <div className="s-alert__body">
        <p className="s-alert__title">Syrup closes on 11 December 2026.</p>
        <p className="s-alert__desc">
          After that date your chats, keys and account are deleted. To keep a chat, open it, choose Share, then Export. Thanks for trying Syrup.
        </p>
      </div>
    </div>
  )
}

/** Cloud-mode frame: the same sidebar as local mode, fed from the account's workspaces. Public pages (sign-in, legal) render without it. */
export function CloudShell({ session, children }: { session: Session | null; children: ReactNode }) {
  const user = session?.user
  return (
    <LogsProvider>
      <Analytics user={user ? { id: user.id, admin: user.admin, email: user.email ?? null, name: user.name ?? null } : null} />
      {user ? (
        <CloudWorkspacesProvider user={{ name: user.name ?? null, email: user.email ?? null, image: user.image ?? null, admin: user.admin }}>
          <NavProvider>
            <div className="flex h-full min-h-0 flex-col">
              <ClosingNotice />
              <div className="min-h-0 flex-1">
                <CloudFrame sidebar={<Sidebar />}>{children}</CloudFrame>
              </div>
            </div>
          </NavProvider>
        </CloudWorkspacesProvider>
      ) : (
        <main className="flex h-full min-w-0 flex-col">{children}</main>
      )}
    </LogsProvider>
  )
}
