import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const dynamic = "force-dynamic"

/**
 * Minimal folder browser for the workspace picker. Single-user, self-hosted:
 * the browser is trusted to see the same file system the agent works in.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("path") ?? ""
  const target = path.resolve(raw || os.homedir())
  let stat: fs.Stats | undefined
  try {
    stat = fs.statSync(target)
  } catch {}
  if (!stat?.isDirectory()) {
    return Response.json({ path: target, exists: false, dirs: [], parent: path.dirname(target) })
  }
  let dirs: { name: string; path: string; git: boolean }[] = []
  try {
    dirs = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => {
        const p = path.join(target, e.name)
        return { name: e.name, path: p, git: fs.existsSync(path.join(p, ".git")) }
      })
      .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name))
      .slice(0, 300)
  } catch {}
  const parent = path.dirname(target)
  return Response.json({
    path: target,
    exists: true,
    git: fs.existsSync(path.join(target, ".git")),
    parent: parent === target ? null : parent,
    dirs,
    home: os.homedir(),
  })
}
