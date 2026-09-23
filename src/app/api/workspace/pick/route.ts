import fs from "node:fs"
import { pickFolder } from "@/server/pick-folder"

export const dynamic = "force-dynamic"
export const maxDuration = 600

/** Opens the native folder dialog on the host and returns the chosen path. */
export async function POST() {
  try {
    const path = await pickFolder()
    if (!path) return Response.json({ cancelled: true })
    if (!fs.existsSync(path)) return Response.json({ error: "That folder no longer exists" }, { status: 400 })
    return Response.json({ path })
  } catch (err) {
    return Response.json({ error: "No folder dialog is available on this machine", detail: err instanceof Error ? err.message : String(err) }, { status: 501 })
  }
}
