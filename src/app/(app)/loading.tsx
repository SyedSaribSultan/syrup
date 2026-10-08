/**
 * Instant feedback while a server-rendered page loads (navigations otherwise look frozen for a network round trip).
 * `.skel-in` holds it back 160 ms, so a fast navigation never flashes it; `.skel` breathes. Under reduced motion the
 * breathing and the fade stop, but the 160 ms wait stays (it is a threshold, not motion).
 */
export default function Loading() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div aria-busy className="skel-in mx-auto w-full max-w-[760px] px-4 py-12 medium:px-6">
        <div className="skel h-8 w-48 rounded-lg" />
        <div className="skel mt-4 h-4 w-full max-w-[520px] rounded" />
        <div className="skel mt-2 h-4 w-3/4 max-w-[420px] rounded" />
        <div className="mt-8 grid gap-3 medium:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[120px] rounded-xl border border-line bg-surface" />
          ))}
        </div>
      </div>
    </div>
  )
}
