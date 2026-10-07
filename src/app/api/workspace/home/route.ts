import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { env } from "@/server/env"
import { slog } from "@/server/log"

export const dynamic = "force-dynamic"

const run = promisify(execFile)

/**
 * The engine snapshots only git worktrees; a plain folder gets no Changes
 * panel and no revert. Home is syrup's own folder, so it gets a repository
 * (no commits, nothing to configure). Other folders are the user's call.
 */
async function ensureGit(home: string) {
  if (fs.existsSync(path.join(home, ".git"))) return
  try {
    await run("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: home, timeout: 15_000 })
    slog("workspace", "home.git_init", { path: home })
  } catch (err) {
    slog("workspace", "home.git_init_failed", err, { level: "warn" })
  }
}

/** The local Home workspace: ~/syrup (%USERPROFILE%\syrup on Windows), created on first ask. */
export async function GET() {
  if (env.isCloud) return Response.json({ error: "not found" }, { status: 404 })
  const home = path.join(os.homedir(), "syrup")
  try {
    if (!fs.existsSync(home)) {
      fs.mkdirSync(home, { recursive: true })
      slog("workspace", "home.created", { path: home })
    }
    await ensureGit(home)
    return Response.json({ path: home })
  } catch (err) {
    slog("workspace", "home.failed", err, { level: "error" })
    return Response.json({ error: `Could not create ${home}` }, { status: 500 })
  }
}
