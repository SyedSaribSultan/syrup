import type { RichError, StaticRender } from "./types"

/**
 * Rendered blocks (docs/RENDERING.md §2.7, §2.14): a memory LRU of 200 entries keyed
 * `kind@version|scheme|widthBucket|hash`, single-flight, so a typewriter frame that re-renders a message costs nothing
 * after a block's first render, and two copies of one block render once.
 */

export type Outcome =
  | { state: "ready"; render: StaticRender; repaired?: "autofix"; source: string; warnings: string[] }
  | { state: "source"; error: RichError }
  | { state: "error"; error: RichError }

type Entry = { outcome: Outcome | null; promise: Promise<Outcome>; subs: Set<() => void> }

export const CACHE_MAX = 200
const map = new Map<string, Entry>()

export function cacheKey(kind: string, version: string, scheme: string, widthBucket: number | null, sourceHash: string): string {
  return `${kind}@${version}|${scheme}|${widthBucket ?? "-"}|${sourceHash}`
}

/**
 * The entry for `key`, produced once (single flight) and kept most-recently-used. `produce` gets the entry (so it can
 * ask whether anyone still shows it) and may resolve null: dropped before it started, so the entry is forgotten and the
 * next reader renders it again.
 */
export function obtain(key: string, produce: (entry: { subs: Set<() => void> }) => Promise<Outcome | null>): Entry {
  const hit = map.get(key)
  if (hit) {
    map.delete(key)
    map.set(key, hit)
    return hit
  }
  const entry: Entry = { outcome: null, promise: null as unknown as Promise<Outcome>, subs: new Set() }
  entry.promise = produce(entry).then((o) => {
    if (o === null) {
      if (map.get(key) === entry) map.delete(key)
      return o as unknown as Outcome
    }
    entry.outcome = o
    for (const f of entry.subs) f()
    return o
  })
  map.set(key, entry)
  while (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  return entry
}

export function peek(key: string): Outcome | null {
  return map.get(key)?.outcome ?? null
}

/** Forgets a result (Retry), so the next read renders again. */
export function drop(key: string): void {
  map.delete(key)
}

export function cacheSize(): number {
  return map.size
}
