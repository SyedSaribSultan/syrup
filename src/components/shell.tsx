"use client"

import { usePathname } from "next/navigation"
import { type ReactNode } from "react"
import { NavProvider } from "@/lib/nav"
import { PanelProvider } from "@/lib/panel"
import { AppShell } from "./app-shell"
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
        <NavProvider>
          <AppShell sidebar={<Sidebar />} pageBar={!chat}>
            {chat ? <Workbench>{children}</Workbench> : children}
          </AppShell>
        </NavProvider>
      </PanelProvider>
    </LogsProvider>
  )
}
