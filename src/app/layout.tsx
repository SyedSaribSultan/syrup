import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono, Lora } from "next/font/google"
import { DialogHost } from "@/components/ui/dialog"
import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })
const lora = Lora({ variable: "--font-lora", subsets: ["latin"], weight: ["400", "500", "600"] })

export const metadata: Metadata = {
  title: "syrup",
  description: "A coding agent powered by your own API keys.",
}

/**
 * Mobile basics. viewport-fit=cover unlocks env(safe-area-inset-*) for the notch and home bar.
 * resizes-content makes the on-screen keyboard shrink the layout (and dvh) on Android; iOS
 * Safari ignores it for now. Zoom stays allowed: inputs are 16px on touch (globals.css), so
 * iOS never zooms on focus and nobody loses pinch-zoom. theme-color tints the browser bars
 * to match the page (--bg).
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1a17" },
  ],
}

/**
 * Document shell only: fonts and styles. The app frame (sidebar, engine,
 * session) comes from the (app) layout, so public share pages (/c/…) render
 * without it and can be cached statically.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${lora.variable} h-full antialiased`}>
      <body className="h-full">
        {children}
        <DialogHost />
      </body>
    </html>
  )
}
