import type { ReactNode } from "react"
import { AppFrame } from "@/components/app-frame"

/** Sign-in keeps the app frame it always had (signed out, that is a bare page with analytics). */
export default function SignInLayout({ children }: { children: ReactNode }) {
  return <AppFrame>{children}</AppFrame>
}
