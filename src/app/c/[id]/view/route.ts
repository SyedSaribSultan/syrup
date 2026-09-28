import { isShareId } from "@/lib/share-link"
import { countView } from "@/server/shares"

export const dynamic = "force-dynamic"

/** View counter beacon from the viewer (one per browser per day). Best effort, never an error to the page. */
export async function POST(_req: Request, ctx: RouteContext<"/c/[id]/view">) {
  const { id } = await ctx.params
  if (isShareId(id)) await countView(id).catch(() => {})
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
}
