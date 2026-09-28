/**
 * Share link basics shared by the request proxy, the server and the browser.
 * Ids are 22 base62 characters (about 131 bits of randomness), generated in
 * src/server/shares.ts; anything else is rejected before touching a database.
 */

export const SHARE_ID_RE = /^[0-9A-Za-z]{22}$/

export function isShareId(id: string | null | undefined): id is string {
  return typeof id === "string" && SHARE_ID_RE.test(id)
}

/** How long an owner's debug link stays valid. */
export const DEBUG_LINK_TTL_S = 24 * 60 * 60

/** What the owner's list and the Share dialog get for one link (never the snapshot itself). */
export type ShareInfo = {
  id: string
  url: string
  sessionId: string
  workspaceId: string | null
  title: string
  models: string[]
  messageCount: number
  bytes: number
  redactions: number
  views: number
  createdAt: number
  updatedAt: number
  /** Counts for "what's included"; present on create/update and on a single-session lookup. */
  stats?: {
    messages: number
    toolCalls: number
    toolErrors: number
    attachments: number
    attachmentsDropped: number
    reasoning: number
    redactions: number
  }
  notes?: string[]
}
