import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { env } from "@/server/env"
import { slog } from "@/server/log"

export const dynamic = "force-dynamic"

/** The local Home workspace: ~/syrup (%USERPROFILE%\syrup on Windows), created on first ask. */
export async function GET() {
  if (env.isCloud) return Response.json({ error: "not found" }, { status: 404 })
  const home = path.join(os.homedir(), "syrup")
  try {
    if (!fs.existsSync(home)) {
      fs.mkdirSync(home, { recursive: true })
      slog("workspace", "home.created", { path: home })
    }
    return Response.json({ path: home })
  } catch (err) {
    slog("workspace", "home.failed", err, { level: "error" })
    return Response.json({ error: `Could not create ${home}` }, { status: 500 })
  }
}
