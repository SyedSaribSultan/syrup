import { renderDebugMarkdown, renderJSON } from "@/lib/transcript"
import { debugBundleForShare, publicBase, verifyDebug, requestOrigin } from "@/server/shares"

export const dynamic = "force-dynamic"

/**
 * The owner's debug bundle for a share: transcript, router events (backend per
 * step, attempts, reasons, time to first token, latency, errors), tool errors
 * and recent logs for the chat, all redacted. Readable without signing in while
 * the HMAC signature (id + expiry, 24 hours at most) holds; 403 after expiry.
 * JSON by default, `?format=md` for Markdown.
 */
export async function GET(req: Request, ctx: RouteContext<"/c/[id]/debug">) {
  const { id } = await ctx.params
  const u = new URL(req.url)
  const headers = { "x-robots-tag": "noindex, nofollow, noarchive", "cache-control": "no-store", "referrer-policy": "no-referrer" }
  const check = verifyDebug(id, u.searchParams.get("exp"), u.searchParams.get("sig"))
  if (check !== "ok") {
    const error = check === "expired" ? "This debug link has expired. Make a new one from the chat's Share menu." : "This debug link is not valid."
    return Response.json({ error }, { status: 403, headers })
  }
  const bundle = await debugBundleForShare(id, Number(u.searchParams.get("exp")) * 1000)
  if (!bundle) return Response.json({ error: "not found: this chat is not shared anymore" }, { status: 404, headers })
  if (u.searchParams.get("format") === "md") {
    return new Response(renderDebugMarkdown(bundle, { url: `${publicBase(requestOrigin(req))}/c/${id}` }), { headers: { ...headers, "content-type": "text/markdown; charset=utf-8" } })
  }
  return new Response(renderJSON(bundle), { headers: { ...headers, "content-type": "application/json; charset=utf-8" } })
}
