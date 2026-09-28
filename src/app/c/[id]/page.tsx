import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { ShareDocument, ViewBeacon } from "@/components/share-view"
import { clipForViewer, firstUserLine } from "@/lib/transcript"
import { getPublicShare } from "@/server/shares"

/**
 * Public viewer for a shared chat. No login, no engine: the snapshot renders
 * with the app's message components in read-only mode. Statically cached per
 * id (ISR); every create, update and revoke expires the page's tag, so a
 * revoked link 404s on the next request. Never indexed: robots meta here,
 * X-Robots-Tag on every /c response (next.config.ts), Disallow in robots.txt.
 */

export const revalidate = 3600

// Render each share on its first visit, then serve it from the cache.
export async function generateStaticParams() {
  return []
}

const NOINDEX: Metadata["robots"] = { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true } }

export async function generateMetadata({ params }: PageProps<"/c/[id]">): Promise<Metadata> {
  const { id } = await params
  const s = await getPublicShare(id)
  if (!s) return { title: "Not shared · syrup", robots: NOINDEX }
  const description = firstUserLine(s.transcript) || "A chat shared from syrup."
  const base = process.env.NEXT_PUBLIC_APP_URL
  return {
    title: `${s.title} · syrup`,
    description,
    robots: NOINDEX,
    referrer: "no-referrer",
    ...(base ? { metadataBase: new URL(base) } : {}),
    alternates: { types: { "text/markdown": `/c/${id}/md`, "application/json": `/c/${id}/json` } },
    openGraph: { title: s.title, description, type: "article", siteName: "syrup" },
    twitter: { card: "summary_large_image", title: s.title, description },
  }
}

export default async function SharedChatPage({ params }: PageProps<"/c/[id]">) {
  const { id } = await params
  const s = await getPublicShare(id)
  if (!s) notFound()
  return (
    <>
      <ShareDocument transcript={clipForViewer(s.transcript)} id={id} homeHref="/" />
      <ViewBeacon id={id} />
    </>
  )
}
