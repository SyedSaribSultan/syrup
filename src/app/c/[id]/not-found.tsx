import Link from "next/link"

/** A missing or revoked share. */
export default function ShareNotFound() {
  return (
    <div className="flex h-full items-center justify-center px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] medium:px-6">
      <div className="max-w-[440px] text-center">
        <Link href="/" prefetch={false} className="font-serif text-[1.35rem] font-semibold tracking-tight text-ink">
          syrup
        </Link>
        <h1 className="mt-6 font-serif text-[1.75rem] leading-tight font-medium tracking-tight text-ink">This chat isn&apos;t shared</h1>
        <p className="mt-2 text-sm text-muted">The link may be mistyped, or its owner stopped sharing it. Shared chats are snapshots their owner can take down at any time.</p>
        <Link href="/" prefetch={false} className="mt-6 inline-block rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-accent-ink transition hover:opacity-90 pointer-coarse:py-3.5">
          Try syrup
        </Link>
      </div>
    </div>
  )
}
