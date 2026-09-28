"use client"

import { usePathname } from "next/navigation"
import { type ReactNode } from "react"
import { PanelProvider } from "@/lib/panel"
import { LogsProvider } from "./logs-modal"
import { Sidebar } from "./sidebar"
import { Workbench } from "./side-panel"

/** Local-mode frame. The chat screens (new chat, a chat) get the Files + Preview panel. */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const chat = pathname === "/" || pathname.startsWith("/s/")
  return (
    <LogsProvider>
      <PanelProvider>
        <div className="flex h-full">
          <Sidebar />
          <main className="relative flex min-w-0 flex-1 flex-col">{chat ? <Workbench>{children}</Workbench> : children}</main>
        </div>
      </PanelProvider>
    </LogsProvider>
  )
}
