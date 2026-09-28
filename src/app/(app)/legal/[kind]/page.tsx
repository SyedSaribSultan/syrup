import Link from "next/link"
import { notFound } from "next/navigation"
import { Markdown } from "@/components/markdown"
import { LEGAL, readLegal, type LegalKind } from "@/server/cloud/legal"

export function generateStaticParams() {
  return Object.keys(LEGAL).map((kind) => ({ kind }))
}

/** Breadcrumb links: small text, but a 44px row on touch screens. */
const CRUMB = "pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"

export default async function LegalPage({ params }: PageProps<"/legal/[kind]">) {
  const { kind } = await params
  if (!(kind in LEGAL)) notFound()
  const doc = readLegal(kind as LegalKind)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Signed out there is no top bar, so the article clears the notch and the home bar itself. */}
      <article className="mx-auto w-full max-w-[720px] px-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] medium:px-6">
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted pointer-coarse:gap-y-0">
          <Link href="/" className={`hover:text-ink ${CRUMB}`}>
            syrup
          </Link>
          <span>·</span>
          {(Object.keys(LEGAL) as LegalKind[]).map((k) => (
            <Link key={k} href={`/legal/${k}`} className={`${k === kind ? "text-ink" : "hover:text-ink"} ${CRUMB}`}>
              {LEGAL[k].title}
            </Link>
          ))}
        </div>
        <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink medium:text-[2rem]">{doc.title}</h1>
        <div className="mt-1 mb-8 text-[12px] text-muted">Version {doc.version}</div>
        {/* Long links wrap instead of widening the page; Markdown already scrolls wide tables and code inside themselves. */}
        <div className="prose-legal text-[15px] leading-relaxed break-words text-ink-2">
          <Markdown text={doc.markdown} />
        </div>
      </article>
    </div>
  )
}
