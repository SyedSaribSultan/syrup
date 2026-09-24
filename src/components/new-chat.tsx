"use client"

import { useRouter } from "next/navigation"
import type { ReactNode } from "react"
import { Composer, type Attachment } from "@/components/composer"
import { useEngine } from "@/lib/engine-store"

/** Empty-state composer: creates a session, navigates to it, sends the first message. */
export function NewChat({ hrefFor, footer, title = "What are we building?" }: { hrefFor(sessionId: string): string; footer?: ReactNode; title?: string }) {
  const router = useRouter()
  const { createSession, send, directory } = useEngine()

  async function onSend(text: string, files: Attachment[]) {
    const s = await createSession()
    router.push(hrefFor(s.id))
    await send(s.id, text, files)
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
      <div className="w-full max-w-[720px]">
        <h1 className="mb-6 text-center font-serif text-[2rem] font-medium tracking-tight text-ink">{title}</h1>
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
        {footer}
      </div>
    </div>
  )
}
