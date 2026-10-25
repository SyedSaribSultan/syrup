/**
 * Instant feedback while a server-rendered page loads (navigations otherwise look frozen for a network round trip).
 * `.skel-in` holds it back 160 ms, so a fast navigation never flashes it. The shapes are the Sarib skeleton
 * (s-skeleton, 03 B18) laid out like a page head and its cards (P2 objects on the canvas).
 */
export default function Loading() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div aria-busy className="skel-in mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-12 medium:px-6">
        <span className="s-skeleton s-skeleton--row w-48" />
        <div className="s-skeleton-stack max-w-[520px]">
          <span className="s-skeleton s-skeleton--line" />
          <span className="s-skeleton s-skeleton--line" />
        </div>
        <div className="mt-4 grid gap-3 medium:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="s-card">
              <div className="s-skeleton-stack">
                <span className="s-skeleton s-skeleton--line" />
                <span className="s-skeleton s-skeleton--line" />
                <span className="s-skeleton s-skeleton--line" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
