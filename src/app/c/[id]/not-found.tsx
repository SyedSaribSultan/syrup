import Link from "next/link"
import { btnClass } from "@/components/ui/s"

/** A missing or revoked share: the Sarib screen-level empty state (03 B18) under the wordmark. */
export default function ShareNotFound() {
  return (
    <div className="flex h-full flex-col bg-canvas pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="s-appbar">
        <Link href="/" prefetch={false} className="s-appbar__brand">
          syrup
        </Link>
      </div>
      <div className="s-empty">
        <h1 className="font-display text-heading text-ink">This chat isn&apos;t shared</h1>
        <p className="s-empty__line max-w-[440px]">The link may be mistyped, or its owner stopped sharing it.</p>
        <p className="s-help max-w-[440px]">Shared chats are snapshots their owner can take down at any time.</p>
        <Link href="/" prefetch={false} className={btnClass({ variant: "secondary" })}>
          <span className="s-btn__label">Try syrup</span>
        </Link>
      </div>
    </div>
  )
}
