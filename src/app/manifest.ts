import type { MetadataRoute } from "next"

/**
 * Installable web app ("Add to Home Screen"): opens full-screen without browser bars.
 * Icons are syrup's white disc on the paper background (public/icons, app/apple-icon.png).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "syrup",
    short_name: "syrup",
    description: "A coding agent powered by your own API keys.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f3f1ea",
    theme_color: "#f3f1ea",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
