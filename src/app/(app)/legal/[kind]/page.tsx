import Link from "next/link"
import { notFound } from "next/navigation"
import { Markdown } from "@/components/markdown"
import { LEGAL, readLegal, type LegalKind } from "@/server/cloud/legal"

export function generateStaticParams() {
  return Object.keys(LEGAL).map((kind) => ({ kind }))
}

/** Nav links: 24 tall, but a 44px target on touch screens (a touch-target size, not a restyle). */
const CRUMB = "pointer-coarse:min-h-11"

export default async function LegalPage({ params }: PageProps<"/legal/[kind]">) {
  const { kind } = await params
  if (!(kind in LEGAL)) notFound()
  const doc = readLegal(kind as LegalKind)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Signed out there is no top bar, so the article clears the notch and the home bar itself. */}
      <article className="mx-auto w-full max-w-[720px] px-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] medium:px-6">
        {/* Nav links (s-btn--link-neutral, DESIGN.md §11.2): the page you are on turns brand through aria-current. */}
        <nav aria-label="Legal" className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-1">
          <Link href="/" className={`s-btn s-btn--link-neutral s-btn--sm ${CRUMB}`}>
            syrup
          </Link>
          {(Object.keys(LEGAL) as LegalKind[]).map((k) => (
            <Link key={k} href={`/legal/${k}`} aria-current={k === kind ? "page" : undefined} className={`s-btn s-btn--link-neutral s-btn--sm ${CRUMB}`}>
              {LEGAL[k].title}
            </Link>
          ))}
        </nav>
        <h1 className="font-display text-heading text-ink">{doc.title}</h1>
        <p className="s-meta mt-2 mb-8">Version {doc.version}</p>
        {/* Long links wrap instead of widening the page; Markdown already scrolls wide tables and code inside themselves. */}
        <div className="prose-legal text-base leading-relaxed break-words text-ink-2">
          <Markdown text={doc.markdown} />
        </div>
      </article>
    </div>
  )
}
