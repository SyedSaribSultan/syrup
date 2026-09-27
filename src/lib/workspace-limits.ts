/** One distinct color per workspace (globals.css --ws-0 … --ws-7), so the cap equals the palette size. */
export const MAX_WORKSPACES = 8

export const LIMIT_MESSAGE = `You can have up to ${MAX_WORKSPACES} workspaces. Remove one to add another.`

/** Lowest color index not in use. */
export function nextColor(used: number[]): number {
  for (let i = 0; i < MAX_WORKSPACES; i++) if (!used.includes(i)) return i
  return used.length % MAX_WORKSPACES
}

export type LocalEntry = { path: string; color: number; used?: number }

/**
 * Puts Home first with color 0. Home counts toward the cap: a full list drops
 * its least recently used entry (never `keep`, the folder in use); that
 * folder's chats stay on disk. A workspace holding color 0 moves to a free one.
 */
export function placeHome(list: LocalEntry[], home: string, keep: string, same: (a: string, b: string) => boolean): LocalEntry[] {
  const found = list.find((w) => same(w.path, home))
  let rest = list.filter((w) => !same(w.path, home))
  if (rest.length >= MAX_WORKSPACES) {
    const candidates = rest.filter((w) => !keep || !same(w.path, keep))
    const drop = candidates.reduce((a, b) => ((b.used ?? 0) < (a.used ?? 0) ? b : a), candidates[0])
    rest = rest.filter((w) => w !== drop).slice(0, MAX_WORKSPACES - 1)
  }
  const taken = rest.map((w) => w.color)
  rest = rest.map((w) => (w.color === 0 ? { ...w, color: nextColor([0, ...taken]) } : w))
  return [found ? { ...found, color: 0 } : { path: home, color: 0 }, ...rest]
}
