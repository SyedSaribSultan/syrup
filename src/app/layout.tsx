import type { Metadata } from "next"
import { Geist, Geist_Mono, Lora } from "next/font/google"
import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })
const lora = Lora({ variable: "--font-lora", subsets: ["latin"], weight: ["400", "500", "600"] })

export const metadata: Metadata = {
  title: "syrup",
  description: "A coding agent powered by your own API keys.",
}

/**
 * Document shell only: fonts and styles. The app frame (sidebar, engine,
 * session) comes from the (app) layout, so public share pages (/c/…) render
 * without it and can be cached statically.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${lora.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  )
}
