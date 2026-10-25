"use client"

import { Button, Icon } from "@/components/ui/s"

/**
 * An error in a page or the app frame (Next 16's error.js, node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/error.md): inside the root layout, so the app's styles and theme still apply. Try again
 * re-renders the segment; Reload starts the page over (a chunk that failed to load needs that).
 * The Sarib full-page error (03 B18): a centred screen-level state on the canvas, plain words with the fix.
 */
export default function AppError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="flex h-full bg-canvas text-ink">
      <div role="alert" className="s-empty">
        <Icon name="circle-alert" />
        <p className="s-empty__line">Something went wrong</p>
        <p className="s-help">This screen hit an error. Your chats are safe. Try again, or reload the page.</p>
        <div className="flex justify-center gap-2">
          <Button variant="secondary" onClick={() => retry()}>
            Try again
          </Button>
          <Button variant="ghost" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    </main>
  )
}
