/** Instant feedback while a server-rendered page loads (navigations otherwise look frozen for a network round trip). */
export default function Loading() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div className="mx-auto w-full max-w-[760px] animate-pulse px-6 py-12">
        <div className="h-8 w-48 rounded-lg bg-surface-2" />
        <div className="mt-4 h-4 w-full max-w-[520px] rounded bg-surface-2" />
        <div className="mt-2 h-4 w-3/4 max-w-[420px] rounded bg-surface-2" />
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[120px] rounded-xl border border-line bg-surface" />
          ))}
        </div>
      </div>
    </div>
  )
}
