"use client"

import Link from "next/link"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { SIDEBAR_SHORTCUT, useNav } from "@/lib/nav"
import { useWorkspaces } from "@/lib/workspaces"
import { IconButton, LinkButton } from "./ui/s"

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
      {/* The scrim fades with the drawer (motion-layer: in slow + arrive, out base + leave) and takes no taps while closed. */}
      <div aria-hidden data-open={open} onClick={nav?.closeDrawer} className="invisible fixed inset-0 z-overlay bg-ink/30 opacity-0 max-expanded:motion-layer data-[open=true]:visible data-[open=true]:opacity-100 expanded:hidden" />
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
        className="invisible fixed inset-y-0 left-0 z-modal flex w-[min(var(--spacing-drawer),calc(100vw-var(--spacing-drawer-gap)))] -translate-x-full outline-none max-expanded:motion-layer data-[open=true]:visible data-[open=true]:translate-x-0 expanded:visible expanded:static expanded:z-auto expanded:w-sidebar expanded:shrink-0 expanded:translate-x-0 expanded:data-[collapsed=true]:w-rail expanded:max-large:data-[forced=true]:w-rail"
      >
        {sidebar}
      </div>
      {/* P1 canvas: the work area sits one plane below the P0 sidebar and bars (sarib-design 03 §1). */}
      <main inert={open || undefined} className="relative flex min-w-0 flex-1 flex-col bg-canvas">
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
  return <IconButton icon="menu" label="Open menu" title={`Menu (${SIDEBAR_SHORTCUT})`} onClick={nav.openDrawer} className={`expanded:hidden ${className}`} />
}

/** Phone/tablet app bar (s-appbar: P0, no border) for pages that have no header of their own: ☰ · syrup · new chat. */
function PageBar() {
  const w = useWorkspaces()
  return (
    <div className="shrink-0 bg-bg pt-[env(safe-area-inset-top)] expanded:hidden">
      <div className="s-appbar">
        <div className="s-appbar__start">
          <MenuButton />
          <Link href="/" className="s-appbar__brand">
            syrup
          </Link>
        </div>
        <div className="s-appbar__end">{w.newChatHref && <LinkButton href={w.newChatHref} variant="ghost" size="sm" icon="edit" label="New chat" />}</div>
      </div>
    </div>
  )
}
