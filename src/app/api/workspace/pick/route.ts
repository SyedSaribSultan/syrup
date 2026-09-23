import fs from "node:fs"
import { slog } from "@/server/log"
import { pickFolder } from "@/server/pick-folder"

export const dynamic = "force-dynamic"
export const maxDuration = 600

/** Opens the native folder dialog on the host and returns the chosen path. */
export async function POST(req: Request) {
  try {
    const startIn = (await req.json().catch(() => ({})))?.startIn
    const t0 = Date.now()
    const path = await pickFolder(typeof startIn === "string" ? startIn : undefined)
    slog("workspace", path ? "pick.chosen" : "pick.cancelled", { path, startIn, ms: Date.now() - t0 })
    if (!path) return Response.json({ cancelled: true })
    if (!fs.existsSync(path)) return Response.json({ error: "That folder no longer exists" }, { status: 400 })
    return Response.json({ path })
  } catch (err) {
    slog("workspace", "pick.failed", err, { level: "error" })
    return Response.json({ error: "No folder dialog is available on this machine", detail: err instanceof Error ? err.message : String(err) }, { status: 501 })
  }
}
