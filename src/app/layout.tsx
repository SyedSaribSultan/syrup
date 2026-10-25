import type { Metadata, Viewport } from "next"
import { Google_Sans_Code, Google_Sans_Flex } from "next/font/google"
import { DialogHost } from "@/components/ui/dialog"
import { Tips } from "@/components/ui/tips"
import { ViewportSync } from "@/components/ui/viewport-sync"
import { THEME_SCRIPT } from "@/lib/theme-script"
import "./globals.css"

// The Sarib design system's two faces (globals.css maps them to font-sans and font-display / font-mono).
const googleSansFlex = Google_Sans_Flex({ variable: "--font-google-sans-flex", subsets: ["latin"], display: "swap" })
const googleSansCode = Google_Sans_Code({ variable: "--font-google-sans-code", subsets: ["latin"], style: ["normal", "italic"], display: "swap" })

export const metadata: Metadata = {
  title: "syrup",
  description: "A coding agent powered by your own API keys.",
  // Added to the iOS home screen it opens full-screen; "default" keeps the status bar above the page.
  appleWebApp: { capable: true, title: "syrup", statusBarStyle: "default" },
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
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0e0c" },
  ],
}

/**
 * Document shell only: fonts and styles. The app frame (sidebar, engine,
 * session) comes from the (app) layout, so public share pages (/c/…) render
 * without it and can be cached statically.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-mode="system": the Sarib tokens follow the OS. THEME_SCRIPT swaps it for data-theme before React hydrates
    // when a light or dark choice is saved (lib/theme.ts).
    <html lang="en" data-mode="system" className={`${googleSansFlex.variable} ${googleSansCode.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full">
        {children}
        <DialogHost />
        <ViewportSync />
        <Tips />
      </body>
    </html>
  )
}
