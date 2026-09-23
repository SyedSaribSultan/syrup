"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { Composer, type Attachment } from "@/components/composer"
import { useEngine } from "@/lib/engine-store"

export function LocalHome() {
  const router = useRouter()
  const { createSession, send, models, directory, hasKeys, providers } = useEngine()

  async function onSend(text: string, files: Attachment[]) {
    const s = await createSession()
    router.push(`/s/${s.id}`)
    await send(s.id, text, files)
  }

  const freeCount = models.filter((m) => m.free && m.providerID !== "syrup").length

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
      <div className="w-full max-w-[720px]">
        <h1 className="mb-6 text-center font-serif text-[2rem] font-medium tracking-tight text-ink">What are we building?</h1>
        <Composer onSend={onSend} autoFocus />
        <p className="mt-4 text-center text-xs text-muted">
          {directory ? (
            <>
              Working in <span className="font-mono text-ink-2">{directory}</span>
            </>
          ) : (
            "Connecting to engine…"
          )}
        </p>

        {providers.length > 0 && !hasKeys && (
          <div className="mx-auto mt-8 max-w-[560px] rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">No API keys yet.</span> {freeCount} free models work out of the box, but <span className="font-mono">Auto</span> and <span className="font-mono">Fast</span> need at least one provider key to route to.{" "}
            <Link href="/settings/providers" className="text-accent underline underline-offset-2">
              Add a key
            </Link>{" "}
            — Google AI Studio is free and takes a minute.
          </div>
        )}
      </div>
    </div>
  )
}
