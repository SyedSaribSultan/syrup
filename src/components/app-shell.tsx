"use client"

import Link from "next/link"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { SIDEBAR_SHORTCUT, useNav } from "@/lib/nav"
import { useWorkspaces } from "@/lib/workspaces"

/**
 * The one app layout, local and cloud (docs/RESPONSIVE.md §4). Below the
 * `expanded` breakpoint the sidebar is a drawer over the page, opened with ☰;
 * from there up it is a column, or an icon rail when collapsed. Chat screens
 * put the ☰ in their own header; other pages get a slim top bar on phones.
 */
export function AppShell({ sidebar, pageBar, children }: { sidebar: ReactNode; pageBar?: boolean; children: ReactNode }) {
  const nav = useNav()
  const open = !!nav?.drawerOpen
  const drawer = useRef<HTMLDivElement>(null)
  // Swipe the open drawer left to close it (touch only; edge-swipe to open would fight the browser's back gesture).
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const [dx, setDx] = useState(0)

  useEffect(() => {
    if (open) drawer.current?.focus()
  }, [open])

  return (
    // min-w-0: in a cloud workspace this is a flex item (cloud-frame.tsx). Without it, its minimum width is the
    // chat's widest unbreakable line (a code line, a tool command, the routed-model line), and the whole app,
    // header and composer included, grows wider than a phone screen.
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      {open && <div aria-hidden onClick={nav?.closeDrawer} className="fixed inset-0 z-40 bg-black/40 expanded:hidden" />}
      <div
        ref={drawer}
        tabIndex={-1}
        data-open={open}
        data-collapsed={!!nav?.collapsed}
        data-forced={!!nav?.railForced}
        role={open ? "dialog" : undefined}
        aria-modal={open || undefined}
        aria-label="Navigation"
        onPointerDown={(e) => {
          if (open && e.pointerType === "touch") swipe.current = { x: e.clientX, y: e.clientY }
        }}
        onPointerMove={(e) => {
          const s = swipe.current
          if (!s) return
          const x = e.clientX - s.x
          // Mostly vertical: the chat list is scrolling, not a swipe.
          if (Math.abs(e.clientY - s.y) > Math.abs(x) && dx === 0) swipe.current = null
          else setDx(Math.min(0, x))
        }}
        onPointerUp={() => {
          if (swipe.current && dx < -60) nav?.closeDrawer()
          swipe.current = null
          setDx(0)
        }}
        onPointerCancel={() => {
          swipe.current = null
          setDx(0)
        }}
        style={dx ? { translate: `${dx}px 0`, transition: "none" } : undefined}
        // motion-layer only while it is a drawer: from `expanded` up it is a column, and sidebar ↔ rail stays instant until M3 (docs/MOTION.md §6.1).
        className="invisible fixed inset-y-0 left-0 z-50 flex w-[min(80vw,320px)] -translate-x-full bg-bg shadow-card outline-none max-expanded:motion-layer data-[open=true]:visible data-[open=true]:translate-x-0 expanded:visible expanded:static expanded:z-auto expanded:w-[264px] expanded:shrink-0 expanded:translate-x-0 expanded:shadow-none expanded:data-[collapsed=true]:w-16 expanded:max-large:data-[forced=true]:w-16"
      >
        {sidebar}
      </div>
      <main inert={open || undefined} className="relative flex min-w-0 flex-1 flex-col">
        {pageBar && <PageBar />}
        {children}
      </main>
    </div>
  )
}

/** ☰: opens the drawer. Only shown where the sidebar is a drawer (phones and tablets). */
export function MenuButton({ className = "" }: { className?: string }) {
  const nav = useNav()
  if (!nav) return null
  return (
    <button
      type="button"
      onClick={nav.openDrawer}
      aria-label="Open menu"
      title={`Menu (${SIDEBAR_SHORTCUT})`}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11 expanded:hidden ${className}`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M3 5.5h12M3 12.5h12" />
      </svg>
    </button>
  )
}

/** Phone/tablet top bar for pages that have no header of their own: ☰ · syrup · new chat. */
function PageBar() {
  const w = useWorkspaces()
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 pt-[env(safe-area-inset-top)] expanded:hidden">
      <div className="flex h-12 flex-1 items-center gap-1 pointer-coarse:h-14">
        <MenuButton />
        <Link href="/" className="px-1 font-serif text-[1.2rem] font-semibold tracking-tight text-ink">
          syrup
        </Link>
        <span className="flex-1" />
        {w.newChatHref && (
          <Link href={w.newChatHref} aria-label="New chat" title="New chat" className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11">
            <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2.5H4A1.5 1.5 0 0 0 2.5 4v9A1.5 1.5 0 0 0 4 14.5h9a1.5 1.5 0 0 0 1.5-1.5V9M12.3 2.2l2.5 2.5L8.5 11H6V8.5l6.3-6.3Z" />
            </svg>
          </Link>
        )}
      </div>
    </div>
  )
}
