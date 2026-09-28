import { renderMarkdown } from "@/lib/transcript"
import { getPublicShare, publicBase, requestOrigin } from "@/server/shares"

/** A shared chat as Markdown (format syrup.transcript v1, see src/lib/transcript.ts). Same visibility as the page. */
export async function GET(req: Request, ctx: RouteContext<"/c/[id]/md">) {
  const { id } = await ctx.params
  const s = await getPublicShare(id)
  const headers = { "x-robots-tag": "noindex, nofollow, noarchive", "cache-control": "public, max-age=0, must-revalidate" }
  if (!s) return new Response("Not found. This chat is not shared, or its owner stopped sharing it.\n", { status: 404, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } })
  const url = `${publicBase(requestOrigin(req))}/c/${id}`
  return new Response(renderMarkdown(s.transcript, { url }), { headers: { ...headers, "content-type": "text/markdown; charset=utf-8" } })
}
