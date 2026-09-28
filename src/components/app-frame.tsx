import type { ReactNode } from "react"
import { CloudShell } from "@/components/cloud-shell"
import { Shell } from "@/components/shell"
import { EngineProvider } from "@/lib/engine-store"
import { LocalWorkspacesProvider } from "@/lib/workspaces"
import { env } from "@/server/env"

/**
 * The app's frame (sidebar, engine connection, workspaces). Every app page
 * gets it through the (app) layout; public share pages (/c/…) live outside it,
 * so a viewer never mounts the engine, the sidebar or a session check.
 */
export async function AppFrame({ children }: { children: ReactNode }) {
  if (env.isCloud) {
    const { auth } = await import("@/auth")
    const session = await auth()
    return <CloudShell session={session}>{children}</CloudShell>
  }
  return (
    <EngineProvider>
      <LocalWorkspacesProvider>
        <Shell>{children}</Shell>
      </LocalWorkspacesProvider>
    </EngineProvider>
  )
}
