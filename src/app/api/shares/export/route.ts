import { renderDebugMarkdown, renderJSON, renderMarkdown } from "@/lib/transcript"
import { handler } from "@/server/cloud/session"
import { currentOwner } from "@/server/share-owner"
import { exportForOwner } from "@/server/shares"

export const dynamic = "force-dynamic"

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "chat"
  )
}

/**
 * The owner's chat as a sanitized transcript, without creating a link. Used by
 * the Share dialog's Export buttons and by `pnpm chat:export`.
 *   ?session=<id|latest>  &format=md|json|bundle  &debug=1  &download=1
 *   local: &directory=<folder>   cloud: &workspace=<id>
 * `bundle` is { transcript, debug? } for the CLI, which renders with the same serializers.
 */
export const GET = handler(async (req: Request) => {
  const owner = await currentOwner()
  const u = new URL(req.url)
  const sessionId = u.searchParams.get("session") ?? ""
  if (!sessionId || sessionId.length > 200) return Response.json({ error: "session must be a chat id or latest" }, { status: 400 })
  const format = u.searchParams.get("format") ?? "md"
  if (!["md", "json", "bundle"].includes(format)) return Response.json({ error: "format must be md, json or bundle" }, { status: 400 })
  const debug = u.searchParams.get("debug") === "1"
  const out = await exportForOwner(owner, { sessionId, directory: u.searchParams.get("directory"), workspaceId: u.searchParams.get("workspace"), debug })
  const name = `${slug(out.transcript.title)}${debug ? "-debug" : ""}`
  const headers: Record<string, string> = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" }
  if (format === "bundle") return Response.json({ sessionId: out.sessionId, transcript: out.transcript, debug: out.debug ?? null }, { headers })
  if (u.searchParams.get("download") === "1") headers["content-disposition"] = `attachment; filename="${name}.${format === "md" ? "md" : "json"}"`
  if (format === "json") return new Response(renderJSON(out.debug ?? out.transcript), { headers: { ...headers, "content-type": "application/json; charset=utf-8" } })
  return new Response(out.debug ? renderDebugMarkdown(out.debug) : renderMarkdown(out.transcript), { headers: { ...headers, "content-type": "text/markdown; charset=utf-8" } })
})
