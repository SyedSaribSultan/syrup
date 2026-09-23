import Link from "next/link"
import { notFound } from "next/navigation"
import { Markdown } from "@/components/markdown"
import { LEGAL, readLegal, type LegalKind } from "@/server/cloud/legal"

export function generateStaticParams() {
  return Object.keys(LEGAL).map((kind) => ({ kind }))
}

export default async function LegalPage({ params }: PageProps<"/legal/[kind]">) {
  const { kind } = await params
  if (!(kind in LEGAL)) notFound()
  const doc = readLegal(kind as LegalKind)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto w-full max-w-[720px] px-6 py-12">
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          <Link href="/" className="hover:text-ink">
            syrup
          </Link>
          <span>·</span>
          {(Object.keys(LEGAL) as LegalKind[]).map((k) => (
            <Link key={k} href={`/legal/${k}`} className={k === kind ? "text-ink" : "hover:text-ink"}>
              {LEGAL[k].title}
            </Link>
          ))}
        </div>
        <h1 className="font-serif text-[2rem] font-medium tracking-tight text-ink">{doc.title}</h1>
        <div className="mt-1 mb-8 text-[12px] text-muted">Version {doc.version}</div>
        <div className="prose-legal text-[15px] leading-relaxed text-ink-2">
          <Markdown text={doc.markdown} />
        </div>
      </article>
    </div>
  )
}
