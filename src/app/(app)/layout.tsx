import type { ReactNode } from "react"
import { AppFrame } from "@/components/app-frame"

/** Every app page: the sidebar, the engine connection (local) or the session (cloud). */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppFrame>{children}</AppFrame>
}
