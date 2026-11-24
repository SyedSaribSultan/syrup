"use client"

import "./globals.css"

/**
 * The last line of defence (Next 16's global-error.js, node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/error.md): an error in the root layout itself. It replaces the whole document, so it brings its
 * own <html> and <body> and imports the styles itself. data-mode="system" follows the OS colour scheme; the fonts fall
 * back to the system faces (the next/font variables live in the root layout this replaces).
 */
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" data-mode="system">
      <body className="flex min-h-dvh bg-canvas text-ink">
        <title>syrup</title>
        <main role="alert" className="s-empty">
          <p className="s-empty__line">Something went wrong</p>
          <p className="s-help">syrup hit an error it couldn&apos;t recover from. Your chats are safe. Try again, or reload the page.</p>
          <div className="flex justify-center gap-2">
            <button type="button" onClick={() => retry()} className="s-btn s-btn--secondary">
              <span className="s-btn__label">Try again</span>
            </button>
            <button type="button" onClick={() => location.reload()} className="s-btn s-btn--ghost">
              <span className="s-btn__label">Reload</span>
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
