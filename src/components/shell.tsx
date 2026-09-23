"use client"

import { type ReactNode } from "react"
import { Sidebar } from "./sidebar"

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  )
}
