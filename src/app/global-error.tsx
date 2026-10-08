"use client"

/**
 * The last line of defence (Next 16's global-error.js, node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/error.md): an error in the root layout itself. It replaces the whole document, so it brings its
 * own <html>, <body> and styles (globals.css isn't loaded here) and follows the system's colour scheme.
 */
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "grid", placeItems: "center", fontFamily: "ui-sans-serif, system-ui, sans-serif", background: "Canvas", color: "CanvasText", colorScheme: "light dark" }}>
        <title>syrup</title>
        <main style={{ maxWidth: 360, padding: 24, textAlign: "center", lineHeight: 1.5 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 14, margin: "0 0 16px", opacity: 0.75 }}>syrup hit an error it couldn&apos;t recover from. Your chats are safe.</p>
          <button type="button" onClick={() => retry()} style={{ font: "inherit", fontSize: 14, padding: "8px 14px", marginRight: 8, borderRadius: 8, border: "1px solid GrayText", background: "transparent", color: "inherit", cursor: "pointer" }}>
            Try again
          </button>
          <button type="button" onClick={() => location.reload()} style={{ font: "inherit", fontSize: 14, padding: "8px 14px", borderRadius: 8, border: "1px solid GrayText", background: "transparent", color: "inherit", cursor: "pointer" }}>
            Reload
          </button>
        </main>
      </body>
    </html>
  )
}
