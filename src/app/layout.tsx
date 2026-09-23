import type { Metadata } from "next"
import { Geist, Geist_Mono, Lora } from "next/font/google"
import "./globals.css"
import { CloudShell } from "@/components/cloud-shell"
import { Shell } from "@/components/shell"
import { EngineProvider } from "@/lib/engine-store"
import { env } from "@/server/env"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })
const lora = Lora({ variable: "--font-lora", subsets: ["latin"], weight: ["400", "500", "600"] })

export const metadata: Metadata = {
  title: "syrup",
  description: "A coding agent powered by your own API keys.",
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  let body
  if (env.isCloud) {
    const { auth } = await import("@/auth")
    const session = await auth()
    body = <CloudShell session={session}>{children}</CloudShell>
  } else {
    body = (
      <EngineProvider>
        <Shell>{children}</Shell>
      </EngineProvider>
    )
  }
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${lora.variable} h-full antialiased`}>
      <body className="h-full">{body}</body>
    </html>
  )
}
