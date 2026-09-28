"use client"

import { usePathname, useRouter } from "next/navigation"
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { useWorkspaces } from "./workspaces"

/**
 * The app shell's navigation state (docs/RESPONSIVE.md §4), one per app: the
 * phone/tablet drawer (open or shut, never persisted) and the desktop sidebar's
 * collapsed-to-rail preference (persisted in localStorage). Mounted above every
 * frame, so it survives moving between a workspace and the settings pages.
 */

const KEY = "syrup.sidebar"
/** Matches the `expanded:` breakpoint in globals.css: from here the sidebar is part of the layout, not a drawer. */
const EXPANDED_QUERY = "(min-width: 52.5rem)"

let cache: boolean | null = null
const subs = new Set<() => void>()

function readCollapsed(): boolean {
  if (cache === null) {
    try {
      cache = localStorage.getItem(KEY) === "rail"
    } catch {
      cache = false
    }
  }
  return cache
}

function writeCollapsed(v: boolean) {
  cache = v
  try {
    localStorage.setItem(KEY, v ? "rail" : "full")
  } catch {}
  for (const f of subs) f()
}

function subscribe(f: () => void) {
  subs.add(f)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    cache = null
    f()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    subs.delete(f)
    window.removeEventListener("storage", onStorage)
  }
}

type Nav = {
  drawerOpen: boolean
  openDrawer(): void
  closeDrawer(): void
  /** Desktop only: the sidebar shows as a narrow icon rail. */
  collapsed: boolean
  toggleCollapsed(): void
  /** The one "sidebar" action: opens/closes the drawer on phones and tablets, collapses/expands it on desktop. */
  toggle(): void
  /**
   * Set while the side panel is open. Between the expanded and large breakpoints (840–1199px) the
   * sidebar then shows as the rail, so the chat keeps room next to the panel; it comes back on close.
   */
  railForced: boolean
  setRailForced(v: boolean): void
}

const NavContext = createContext<Nav | null>(null)

export function NavProvider({ children }: { children: ReactNode }) {
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [railForced, setRailForced] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const newChatHref = useWorkspaces().newChatHref

  // Navigating (tapping a chat or a page in the drawer) closes the drawer.
  const [openedAt, setOpenedAt] = useState(pathname)
  if (drawerOpen && openedAt !== pathname) {
    setDrawerOpen(false)
    setOpenedAt(pathname)
  }

  const openDrawer = useCallback(() => {
    setOpenedAt(pathname)
    setDrawerOpen(true)
  }, [pathname])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const toggleCollapsed = useCallback(() => writeCollapsed(!readCollapsed()), [])
  const toggle = useCallback(() => {
    if (window.matchMedia(EXPANDED_QUERY).matches) toggleCollapsed()
    else if (drawerOpen) closeDrawer()
    else openDrawer()
  }, [drawerOpen, openDrawer, closeDrawer, toggleCollapsed])

  // Growing the window past the breakpoint turns the drawer into the sidebar; don't leave it "open" behind the scenes.
  useEffect(() => {
    const mq = window.matchMedia(EXPANDED_QUERY)
    const onChange = () => mq.matches && setDrawerOpen(false)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  // Ctrl+B (⌘B) toggles the sidebar, Ctrl+Shift+O (⌘⇧O) starts a new chat, "/" jumps to the composer
  // when you're not typing somewhere else; Escape closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey
      const key = e.key.toLowerCase()
      if (mod && !e.shiftKey && key === "b") {
        e.preventDefault()
        toggle()
      } else if (mod && e.shiftKey && key === "o" && newChatHref) {
        e.preventDefault()
        router.push(newChatHref)
      } else if (e.key === "/" && !mod && !e.shiftKey) {
        const t = e.target as HTMLElement | null
        if (t?.closest("input, textarea, select, [contenteditable=true], dialog")) return
        const composer = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")
        if (!composer) return
        e.preventDefault()
        composer.focus()
      } else if (e.key === "Escape" && drawerOpen) closeDrawer()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle, drawerOpen, closeDrawer, newChatHref, router])

  return <NavContext.Provider value={{ drawerOpen, openDrawer, closeDrawer, collapsed, toggleCollapsed, toggle, railForced, setRailForced }}>{children}</NavContext.Provider>
}

export function useNav(): Nav | null {
  return useContext(NavContext)
}

export const SIDEBAR_SHORTCUT = "Ctrl+B or ⌘B"
