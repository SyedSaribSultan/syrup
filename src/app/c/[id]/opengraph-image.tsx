import { ImageResponse } from "next/og"
import { firstUserLine } from "@/lib/transcript"
import { getPublicShare } from "@/server/shares"

/** Link preview for a shared chat: the title and the first thing the user asked, in syrup's warm paper style. */

export const alt = "A chat shared from syrup"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"
export const revalidate = 3600

export async function generateStaticParams() {
  return []
}

// syrup's light palette (src/app/globals.css).
const C = { bg: "#f3f1ea", ink: "#23211d", ink2: "#4f4c45", muted: "#8a867c", line: "#e3e0d6", accent: "#c8623f", accentSoft: "#f6e3da", bubble: "#eceae1" }

/**
 * One Google font, subset to exactly the glyphs in `text` (a small TTF from the Google Fonts API).
 * Null when offline; the image then uses the default font throughout.
 */
async function loadFont(family: string, weight: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&text=${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(2500) }).then((r) => r.text())
    const url = css.match(/src:\s*url\(([^)]+)\)\s*format\(["']?(truetype|opentype)["']?\)/)?.[1]
    if (!url) return null
    return await fetch(url, { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.arrayBuffer() : null))
  } catch {
    return null
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const s = await getPublicShare(id)
  if (!s) return new Response("not found", { status: 404 })
  const title = clip(s.transcript.title || "A shared chat", 90)
  const asked = clip(firstUserLine(s.transcript, 220), 220)
  const stats = `${s.transcript.stats.messages} messages${s.transcript.models.length ? ` · ${clip(s.transcript.models.slice(0, 2).join(", "), 60)}` : ""}`
  const tagline = "A free-first coding agent"
  // Headings in Lora, the rest in Geist, like the app. Both or neither: custom fonts replace the default one.
  const [lora, geist] = await Promise.all([loadFont("Lora", 500, `syrup${title}`), loadFont("Geist", 400, `Shared chat${asked}${stats}${tagline}…`)])
  const fonts = lora && geist ? [{ name: "Lora", data: lora, weight: 500 as const, style: "normal" as const }, { name: "Geist", data: geist, weight: 400 as const, style: "normal" as const }] : undefined
  const serif = fonts ? "Lora" : "serif"
  const sans = fonts ? "Geist" : "sans-serif"
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: C.bg, padding: "64px 72px", color: C.ink, fontFamily: sans }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontFamily: serif, fontSize: 44, fontWeight: 500, letterSpacing: -1 }}>syrup</div>
          <div style={{ display: "flex", fontSize: 24, color: C.accent, background: C.accentSoft, padding: "8px 18px", borderRadius: 999 }}>Shared chat</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontFamily: serif, fontSize: title.length > 50 ? 60 : 72, fontWeight: 500, lineHeight: 1.1, letterSpacing: -1.5 }}>{title}</div>
          {asked && (
            <div style={{ display: "flex", marginTop: 36, alignSelf: "flex-end", maxWidth: 860, background: C.bubble, color: C.ink2, fontSize: 28, lineHeight: 1.4, padding: "20px 28px", borderRadius: 28, borderBottomRightRadius: 8 }}>{asked}</div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: C.muted, borderTop: `2px solid ${C.line}`, paddingTop: 22 }}>
          <div style={{ display: "flex" }}>{stats}</div>
          <div style={{ display: "flex" }}>{tagline}</div>
        </div>
      </div>
    ),
    { ...size, fonts, headers: { "x-robots-tag": "noindex, nofollow" } },
  )
}
