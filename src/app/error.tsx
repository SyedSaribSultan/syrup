"use client"

/**
 * An error in a page or the app frame (Next 16's error.js, node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/error.md): inside the root layout, so the app's styles and theme still apply. Try again
 * re-renders the segment; Reload starts the page over (a chunk that failed to load needs that).
 */
export default function AppError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const btn = "rounded-lg border border-line px-3.5 py-2 text-[13px] text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:min-h-11"
  return (
    <main className="flex h-full items-center justify-center bg-bg p-6 text-ink">
      <div className="max-w-[360px] text-center">
        <h1 className="text-[17px] font-medium">Something went wrong</h1>
        <p className="mt-1.5 text-[14px] leading-6 text-ink-2">This screen hit an error. Your chats are safe.</p>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" onClick={() => retry()} className={btn}>
            Try again
          </button>
          <button type="button" onClick={() => location.reload()} className={btn}>
            Reload
          </button>
        </div>
      </div>
    </main>
  )
}
