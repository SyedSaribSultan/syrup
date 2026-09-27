"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

/** Cloud layout frame. Inside a workspace (/w/…) WorkspaceView renders the sidebar itself, within the workspace's engine connection. */
export function CloudFrame({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const inWorkspace = usePathname().startsWith("/w/")
  return (
    <div className="flex h-full">
      {!inWorkspace && sidebar}
      <main className="relative flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  )
}
