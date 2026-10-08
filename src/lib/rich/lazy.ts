"use client"

import { useCallback, useSyncExternalStore } from "react"
import { fenceKind } from "./kinds"
import { loadRenderer } from "./loaders"

/**
 * Lazy chunks read during render (docs/RENDERING.md §2.3). One record per loader, kept for the page's life, read
 * through useSyncExternalStore: a loaded chunk renders at once (no fallback flash), and the server snapshot is
 * "not loaded", so a shared chat hydrates without a mismatch. Loading starts when something subscribes, never during
 * render. A failed import retries once after 1 s, then reports `failed`; `retry()` imports again.
 */

export type Lazy<T> = { module: T | null; failed: boolean; retry(): void }

type Rec<T> = { module: T | null; failed: boolean; promise: Promise<T> | null; subs: Set<() => void>; snap: Lazy<T> }

const recs = new Map<() => Promise<unknown>, Rec<unknown>>()

function rec<T>(load: () => Promise<T>): Rec<T> {
  let r = recs.get(load) as Rec<T> | undefined
  if (!r) {
    const fresh: Rec<T> = { module: null, failed: false, promise: null, subs: new Set(), snap: null as unknown as Lazy<T> }
    fresh.snap = { module: null, failed: false, retry: () => retryLoad(load) }
    recs.set(load, fresh as Rec<unknown>)
    r = fresh
  }
  return r
}

function publish<T>(r: Rec<T>, load: () => Promise<T>) {
  r.snap = { module: r.module, failed: r.failed, retry: () => retryLoad(load) }
  for (const f of r.subs) f()
}

/** Starts loading (once) and resolves with the module; rejects only after the retry failed too. */
export function ensure<T>(load: () => Promise<T>): Promise<T> {
  const r = rec(load)
  if (r.module) return Promise.resolve(r.module)
  if (!r.promise) {
    r.failed = false
    r.promise = load()
      .catch(() => new Promise<T>((resolve, reject) => setTimeout(() => load().then(resolve, reject), 1000)))
      .then(
        (m) => {
          r.module = m
          publish(r, load)
          return m
        },
        (err: unknown) => {
          r.failed = true
          r.promise = null
          publish(r, load)
          throw err
        },
      )
    r.promise.catch(() => {})
  }
  return r.promise
}

function retryLoad<T>(load: () => Promise<T>) {
  const r = rec(load)
  if (r.module || r.promise) return
  r.failed = false
  publish(r, load)
  void ensure(load).catch(() => {})
}

const SERVER: Lazy<never> = { module: null, failed: false, retry: () => {} }

/**
 * The module once loaded (null on the server and during hydration), whether loading failed, and a retry. With
 * `active` false it only reads: nothing loads until something needs it (a text that may hold math).
 */
export function useLazy<T>(load: () => Promise<T>, active = true): Lazy<T> {
  const r = rec(load)
  const subscribe = useCallback(
    (f: () => void) => {
      r.subs.add(f)
      if (active && !r.module && !r.failed) void ensure(load).catch(() => {})
      return () => {
        r.subs.delete(f)
      }
    },
    [r, load, active],
  )
  return useSyncExternalStore(subscribe, () => r.snap, () => SERVER)
}

/** Already loaded: for code that must not wait (the export, a click). */
export function loaded<T>(load: () => Promise<T>): T | null {
  return (recs.get(load)?.module as T | undefined) ?? null
}

export const loadCore = () => import("@/components/rich/core")
export const loadMath = () => import("@/lib/rich/math-parse")
export const loadKatex = () => import("@/components/rich/renderers/math")

/** Text that may hold math: `$`, `\(` or `\[`. Prices match too; the parser loads briefly for them. */
export const MATH_MARK = /\$|\\\(|\\\[/

const idle = (f: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  if (w.requestIdleCallback) w.requestIdleCallback(f, { timeout: 2000 })
  else setTimeout(f, 1)
}

const FENCE_LANG = /^ {0,3}(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?(?:`{3,}|~{3,})\s*([\w-]+)/gm

/**
 * Warms what a text part will need, on idle: the core and the renderers of its fence languages, the math parser when
 * it has a math marker, KaTeX when it looks like real math.
 */
export function prefetchFor(text: string): void {
  if (typeof window === "undefined" || !text) return
  idle(() => {
    let rich = false
    for (const m of text.matchAll(FENCE_LANG)) {
      const kind = fenceKind(m[1])
      const load = kind && loadRenderer(kind)
      if (!load) continue
      rich = true
      void ensure(load).catch(() => {})
    }
    if (rich) void ensure(loadCore).catch(() => {})
    if (MATH_MARK.test(text)) {
      void ensure(loadMath).catch(() => {})
      if (/\$\$|\\\(|\\\[|\$[^\s$\d][^$\n]*[^\s$]\$/.test(text)) void ensure(loadKatex).catch(() => {})
    }
  })
}
