import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"
import { DialogHost } from "@/components/ui/dialog"
import { Tips } from "@/components/ui/tips"
import { ViewportSync } from "@/components/ui/viewport-sync"
import { THEME_SCRIPT } from "@/lib/theme-script"
import "./globals.css"

// The Sarib design system's two faces (globals.css maps them to font-sans and font-display / font-mono), from the
// design system's own vendored files (src/sarib/fonts: Google's latin woff2 subsets, OFL). next/font/local keeps the
// preload and the size-adjusted fallback next/font/google gave, without fetching from Google at build time.
const googleSansFlex = localFont({
  variable: "--font-google-sans-flex",
  src: [{ path: "../sarib/fonts/flex-latin.woff2", weight: "1 1000", style: "normal" }],
  display: "swap",
})
const googleSansCode = localFont({
  variable: "--font-google-sans-code",
  src: [
    { path: "../sarib/fonts/code-latin.woff2", weight: "300 800", style: "normal" },
    { path: "../sarib/fonts/code-italic-latin.woff2", weight: "300 800", style: "italic" },
  ],
  display: "swap",
})

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
    // when a light or dark choice is saved (lib/theme.ts). data-scale="app": sarib-design's app scale (DESIGN.md §4.6),
    // the dense tool-chrome sizes (14 UI text, 32 rows and buttons, 256 sidebar, 48 bars) for every screen.
    <html lang="en" data-mode="system" data-scale="app" className={`${googleSansFlex.variable} ${googleSansCode.variable} h-full antialiased`} suppressHydrationWarning>
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
