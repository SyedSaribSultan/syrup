"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { AppShell } from "./app-shell"

/**
 * Cloud layout frame. Inside a workspace (/w/…) WorkspaceView renders the same AppShell itself, so its
 * sidebar sits within the workspace's engine connection; drawer and rail state live in NavProvider above both.
 */
export function CloudFrame({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const inWorkspace = usePathname().startsWith("/w/")
  if (inWorkspace) return <div className="flex h-full min-h-0">{children}</div>
  return (
    <AppShell sidebar={sidebar} pageBar>
      {children}
    </AppShell>
  )
}
