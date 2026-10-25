"use client"

import { Button, Icon } from "./ui/s"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Brew } from "@/components/brew"
import { Composer, type Attachment } from "@/components/composer"
import { PanelToggle } from "@/components/side-panel"
import { engineError, useEngine } from "@/lib/engine-store"
import { useWorkspaces } from "@/lib/workspaces"
import { MenuButton } from "./app-shell"
import { ModelPicker } from "./model-picker"
import { WarmupStatus } from "./warm-up"

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
  const [sendError, setSendError] = useState<string | null>(null)
  const { workspaces, activeId } = useWorkspaces()
  const missing = !!workspaces?.find((w) => w.id === activeId)?.missing
  const freeCount = models.filter((m) => m.free && m.providerID !== "syrup").length
  const showKeys = keysKnown ? !hasKeys : !!noKeys

  async function onSend(text: string, files: Attachment[]) {
    if (!ready) setPending({ text, files })
    setSendError(null)
    try {
      const s = await createSession()
      router.push(hrefFor(s.id))
      await send(s.id, text, files)
    } catch (err) {
      setPending(null)
      setSendError(engineError(err))
      throw err
    }
  }

  const where = directory ? (
    <span className="min-w-0 truncate">
      Working in <span className="font-mono text-ink-2">{directory}</span>
    </span>
  ) : error ? null : (
    <Brew mood="wake" timerAfter={10} />
  )

  // Phones and tablets (docs/RESPONSIVE.md §5.2): a top bar with ☰ and the model, the heading centred in the
  // free space, notices just above the composer, and the composer docked at the bottom in thumb reach.
  // Desktop keeps the centred heading + composer.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 pt-[env(safe-area-inset-top)] expanded:hidden">
        <div className="flex h-12 items-center gap-1 px-2 pointer-coarse:h-14">
          <MenuButton />
          <div className="flex min-w-0 flex-1 items-center">
            <ModelPicker variant="bar" />
          </div>
          <PanelToggle compact />
        </div>
      </div>
      <div className="absolute top-3 right-4 hidden expanded:block">
        <PanelToggle />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-3 medium:px-6 expanded:justify-center expanded:pb-24">
        <div className="flex w-full max-w-[720px] flex-1 flex-col expanded:flex-none">
          <div className="order-1 flex flex-1 flex-col justify-center py-6 expanded:flex-none expanded:py-0">
            {pending ? (
              <div className="mb-6 space-y-4">
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-base leading-6 whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
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
                  <p className="s-empty-line">Not sent yet. It goes out as soon as the workspace starts.</p>
                ) : (
                  <>
                    <Brew mood="wake" label="Sends as soon as your workspace is up" timerAfter={8} />
                    <WarmupStatus queued />
                  </>
                )}
              </div>
            ) : (
              <>
                <h1 className="text-center font-display text-heading font-normal text-ink medium:text-heading expanded:mb-6 [@media(max-height:480px)]:text-xl">
                  What are we <em className="text-accent not-italic">building</em>?
                </h1>
                <div className="mt-2 flex justify-center text-xs text-muted expanded:hidden [@media(max-height:480px)]:hidden">{where}</div>
              </>
            )}
          </div>
          <div className={`order-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] expanded:order-2 expanded:pb-0 ${pending ? "hidden" : ""}`}>
            <Composer onSend={onSend} autoFocus />
          </div>
          {!pending && <div className="order-4 mt-4 hidden justify-center text-xs text-muted expanded:order-3 expanded:flex">{where}</div>}
          <div className="order-2 space-y-3 pb-3 empty:hidden expanded:order-4 expanded:pb-0">
            {!pending && !error && (
              <div className="mx-auto w-full max-w-[560px] empty:hidden expanded:mt-6">
                <WarmupStatus />
              </div>
            )}
            {(sendError || missing) && (
              <div role="alert" className="s-alert s-alert--critical mx-auto max-w-[560px] expanded:mt-6">
                <Icon name="circle-alert" />
                <div className="s-alert__body">
                  {missing ? (
                    <>
                      <p className="s-alert__title">This folder no longer exists.</p>
                      <p className="s-alert__desc">Switch to another workspace from the top of the sidebar, or put the folder back and reload.</p>
                    </>
                  ) : (
                    <>
                      <p className="s-alert__title">Couldn&apos;t start the chat.</p>
                      <p className="s-alert__desc">{sendError}</p>
                    </>
                  )}
                </div>
              </div>
            )}
            {error && (
              <div role="alert" className="s-alert s-alert--critical mx-auto max-w-[560px] expanded:mt-6">
                <Icon name="circle-alert" />
                <div className="s-alert__body">
                  <p className="s-alert__title">Your workspace didn&apos;t start.</p>
                  <p className="s-alert__desc">{error}</p>
                  {onRetry && (
                    <Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">
                      Try again
                    </Button>
                  )}
                </div>
              </div>
            )}
            {showKeys && (
              <div className="s-alert s-alert--info mx-auto max-w-[560px] expanded:mt-8">
                <Icon name="lock" />
                <div className="s-alert__body">
                <p className="s-alert__title">No API keys yet.</p>
                <p className="s-alert__desc">
                {providers.length > 0 ? (
                  <>
                    {freeCount} free models work out of the box, but <span className="font-mono">Auto</span> and <span className="font-mono">Fast</span> need at least one provider key to route to.
                  </>
                ) : (
                  "The agent needs at least one provider key."
                )}{" "}
                <Link href="/settings/providers" className="s-link">
                  Add a key
                </Link>
                . Google AI Studio is free and takes a minute.
                </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
