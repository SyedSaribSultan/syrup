import { renderJSON } from "@/lib/transcript"
import { getPublicShare, publicBase, requestOrigin } from "@/server/shares"

/** A shared chat as JSON: the syrup.transcript v1 object (src/lib/transcript.ts) plus `share` { id, url, markdown, json }. */
export async function GET(req: Request, ctx: RouteContext<"/c/[id]/json">) {
  const { id } = await ctx.params
  const s = await getPublicShare(id)
  const headers = { "x-robots-tag": "noindex, nofollow, noarchive", "cache-control": "public, max-age=0, must-revalidate", "content-type": "application/json; charset=utf-8" }
  if (!s) return new Response(renderJSON({ error: "not found: this chat is not shared, or its owner stopped sharing it" }), { status: 404, headers })
  const url = `${publicBase(requestOrigin(req))}/c/${id}`
  return new Response(renderJSON({ ...s.transcript, share: { id, url, markdown: `${url}/md`, json: `${url}/json` } }), { headers })
}
