import type { Metadata } from "next"
import Link from "next/link"
import { Icon } from "@/components/ui/s"

/**
 * Any unknown URL: the origin's 404 (syedsarib.com not-found.tsx, seam rule 3). s-page on the P1 canvas, crumb
 * "syrup / Not found", Code meta 404, the hero with one accent word, the lede, then two destination cards.
 * Rendered by the root layout only (no sidebar or engine), so it works signed out too.
 */
export const metadata: Metadata = {
  title: "Page not found · syrup",
  description: "This page doesn't exist. Start a new chat or open Settings.",
}

const destinations = [
  { href: "/", kicker: "New chat", title: "Start a new chat", meta: "Ask the agent about your code" },
  { href: "/settings", kicker: "Settings", title: "Open Settings", meta: "Account, privacy and connections" },
] as const

export default function NotFound() {
  return (
    // The page itself never scrolls (globals.css), so this column does.
    <main className="s-page h-full overflow-y-auto pt-[max(var(--s-spacing-4),env(safe-area-inset-top))] pb-[max(var(--s-spacing-4),env(safe-area-inset-bottom))]">
      <div className="s-page__inner">
        <section className="s-pagehead" aria-label="Not found">
          <nav className="s-crumbs" aria-label="Breadcrumb">
            <ol>
              <li>
                <Link href="/">syrup</Link>
              </li>
              <li>
                <span aria-current="page">Not found</span>
              </li>
            </ol>
          </nav>
          <p className="s-pagehead__meta">404</p>
          <h1 className="s-hero">
            This page <em>doesn&apos;t</em> exist.
          </h1>
          <p className="s-lede">The link may be old, or the address has a typo. Here is where to go instead.</p>
        </section>
        <section aria-label="Where to go" className="grid gap-[var(--s-spacing-5)] min-[768px]:grid-cols-2">
          {destinations.map((d) => (
            <Link key={d.href} href={d.href} prefetch={false} className="s-card s-card--compact">
              <span className="s-card__kicker">{d.kicker}</span>
              <span className="s-card__row">
                <span className="s-card__title">{d.title}</span>
                <Icon name="arrow-up-right" className="s-card__arrow" />
              </span>
              <span className="s-card__meta">{d.meta}</span>
            </Link>
          ))}
        </section>
      </div>
    </main>
  )
}
