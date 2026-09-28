"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Brew } from "@/components/brew"
import { Composer, type Attachment } from "@/components/composer"
import { PanelToggle } from "@/components/side-panel"
import { useEngine } from "@/lib/engine-store"

type Props = {
  hrefFor(sessionId: string): string
  /** Known before the engine connects (cloud: from the account), so the key hint shows at once. */
  noKeys?: boolean
  /** The engine could not start. The waiting message stays queued until retry succeeds. */
  error?: string | null
  onRetry?(): void
}

/**
 * Empty-state composer: creates a session, navigates to it, sends the first message.
 * Usable before the engine is up: the message shows as pending and goes out the moment it connects.
 */
export function NewChat({ hrefFor, noKeys, error, onRetry }: Props) {
  const router = useRouter()
  const { createSession, send, directory, models, hasKeys, keysKnown, providers, ready } = useEngine()
  const [pending, setPending] = useState<{ text: string; files: Attachment[] } | null>(null)
  const freeCount = models.filter((m) => m.free && m.providerID !== "syrup").length
  const showKeys = keysKnown ? !hasKeys : !!noKeys

  async function onSend(text: string, files: Attachment[]) {
    if (!ready) setPending({ text, files })
    try {
      const s = await createSession()
      router.push(hrefFor(s.id))
      await send(s.id, text, files)
    } catch (err) {
      setPending(null)
      throw err
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
      <PanelToggle className="absolute top-3 right-4" />
      <div className="w-full max-w-[720px]">
        {pending ? (
          <div className="mb-6 space-y-4">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-ink opacity-70">
                {pending.text}
                {pending.files.length > 0 && (
                  <div className={`flex flex-wrap gap-1.5 ${pending.text ? "mt-2" : ""}`}>
                    {pending.files.map((f, i) => (
                      <span key={i} className="rounded-md border border-line bg-bg px-2 py-0.5 text-xs text-ink-2">
                        📎 {f.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {error ? (
              <div className="text-[13px] text-muted">Not sent yet. It goes out as soon as the workspace starts.</div>
            ) : (
              <Brew mood="wake" label="Sends as soon as your workspace is up" timerAfter={8} />
            )}
          </div>
        ) : (
          <h1 className="mb-6 text-center font-serif text-[2rem] font-medium tracking-tight text-ink">What are we building?</h1>
        )}
        <div className={pending ? "hidden" : ""}>
          <Composer onSend={onSend} autoFocus />
        </div>
        {!pending && (
          <div className="mt-4 flex justify-center text-xs text-muted">
            {directory ? (
              <span>
                Working in <span className="font-mono text-ink-2">{directory}</span>
              </span>
            ) : error ? null : (
              <Brew mood="wake" timerAfter={10} />
            )}
          </div>
        )}
        {error && (
          <div className="mx-auto mt-6 max-w-[560px] rounded-xl border border-err/30 bg-err/5 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            <span className="font-medium text-err">Your workspace didn&apos;t start.</span> {error}
            {onRetry && (
              <button type="button" onClick={onRetry} className="ml-2 rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink">
                Try again
              </button>
            )}
          </div>
        )}
        {showKeys && (
          <div className="mx-auto mt-8 max-w-[560px] rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">No API keys yet.</span>{" "}
            {providers.length > 0 ? (
              <>
                {freeCount} free models work out of the box, but <span className="font-mono">Auto</span> and <span className="font-mono">Fast</span> need at least one provider key to route to.
              </>
            ) : (
              "The agent needs at least one provider key."
            )}{" "}
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
