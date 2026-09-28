import { revalidatePath, revalidateTag } from "next/cache"

/**
 * Cache tags for public share pages. The viewer (/c/[id]) is statically
 * cached per id and its data is tagged; every write to a share (create,
 * update, revoke, the chat or workspace being deleted) expires the tag at once,
 * so a revoked link 404s on the very next request, even from cache.
 */

export function shareTag(id: string): string {
  return `share:${id}`
}

/** Expires everything cached for one share. Safe outside a request (then it does nothing). */
export function invalidateShare(id: string): void {
  try {
    revalidateTag(shareTag(id), { expire: 0 })
  } catch {}
  for (const p of [`/c/${id}`, `/c/${id}/opengraph-image`, `/c/${id}/md`, `/c/${id}/json`]) {
    try {
      revalidatePath(p)
    } catch {}
  }
}
