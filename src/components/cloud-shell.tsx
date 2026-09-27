import type { Session } from "next-auth"
import type { ReactNode } from "react"
import { CloudWorkspacesProvider } from "@/lib/workspaces"
import { Analytics } from "./analytics"
import { CloudFrame } from "./cloud-frame"
import { LogsProvider } from "./logs-modal"
import { Sidebar } from "./sidebar"

/** Cloud-mode frame: the same sidebar as local mode, fed from the account's workspaces. Public pages (sign-in, legal) render without it. */
export function CloudShell({ session, children }: { session: Session | null; children: ReactNode }) {
  const user = session?.user
  return (
    <LogsProvider>
      <Analytics user={user ? { id: user.id, admin: user.admin } : null} />
      {user ? (
        <CloudWorkspacesProvider user={{ name: user.name ?? null, email: user.email ?? null, image: user.image ?? null, admin: user.admin }}>
          <CloudFrame sidebar={<Sidebar />}>{children}</CloudFrame>
        </CloudWorkspacesProvider>
      ) : (
        <main className="flex h-full min-w-0 flex-col">{children}</main>
      )}
    </LogsProvider>
  )
}
