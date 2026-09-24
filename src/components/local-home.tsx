"use client"

import Link from "next/link"
import { NewChat } from "@/components/new-chat"
import { useEngine } from "@/lib/engine-store"

export function LocalHome() {
  const { models, hasKeys, providers } = useEngine()
  const freeCount = models.filter((m) => m.free && m.providerID !== "syrup").length
  return (
    <NewChat
      hrefFor={(id) => `/s/${id}`}
      footer={
        providers.length > 0 && !hasKeys ? (
          <div className="mx-auto mt-8 max-w-[560px] rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">No API keys yet.</span> {freeCount} free models work out of the box, but <span className="font-mono">Auto</span> and <span className="font-mono">Fast</span> need at least one provider key to route to.{" "}
            <Link href="/settings/providers" className="text-accent underline underline-offset-2">
              Add a key
            </Link>{" "}
            — Google AI Studio is free and takes a minute.
          </div>
        ) : null
      }
    />
  )
}
