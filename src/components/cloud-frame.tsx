"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

/** Cloud layout frame. Inside a workspace (/w/…) the workspace's own sidebar takes over, so the global one is hidden. */
export function CloudFrame({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const inWorkspace = usePathname().startsWith("/w/")
  return (
    <div className="flex h-full">
      {!inWorkspace && sidebar}
      <main className="relative flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  )
}
