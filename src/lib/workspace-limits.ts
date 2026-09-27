/** One distinct color per workspace (globals.css --ws-0 … --ws-7), so the cap equals the palette size. */
export const MAX_WORKSPACES = 8

export const LIMIT_MESSAGE = `You can have up to ${MAX_WORKSPACES} workspaces. Remove one to add another.`

/** Lowest color index not in use. */
export function nextColor(used: number[]): number {
  for (let i = 0; i < MAX_WORKSPACES; i++) if (!used.includes(i)) return i
  return used.length % MAX_WORKSPACES
}
