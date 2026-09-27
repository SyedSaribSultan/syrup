import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { slog } from "./log"

/**
 * Shows a workspace file on the desktop syrup runs on: select it in a new
 * File Explorer / Finder window, open it with its default app, or open the
 * folder it is in. Local mode only; the browser and server share a desktop.
 *
 * Only paths inside the workspace the browser sends are accepted, compared
 * after resolving symlinks. Nothing goes through a shell.
 */

export type RevealAction = "reveal" | "open" | "folder"

export class RevealError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const win = process.platform === "win32"

function inside(root: string, p: string): boolean {
  const a = win ? root.toLowerCase() : root
  const b = win ? p.toLowerCase() : p
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)
}

function realpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/** Resolves `target` against `workspace` and checks it stays inside. Throws RevealError. */
export function resolveInWorkspace(workspace: string, target: string): string {
  if (!path.isAbsolute(workspace)) throw new RevealError("workspace must be an absolute path", 400)
  const root = path.resolve(workspace)
  // A drive or filesystem root as "workspace" would make every file fair game.
  if (path.parse(root).root === root) throw new RevealError("workspace cannot be a filesystem root", 400)
  const realRoot = realpath(root)
  if (!realRoot || !fs.statSync(realRoot).isDirectory()) throw new RevealError("workspace folder not found", 400)

  const abs = path.resolve(root, target)
  if (!inside(root, abs)) throw new RevealError("path is outside the workspace", 403)
  const real = realpath(abs)
  if (!real) throw new RevealError("not found", 404)
  if (!inside(realRoot, real)) throw new RevealError("path is outside the workspace", 403)
  // Windows paths cannot contain quotes; the verbatim /select argument below relies on it.
  if (real.includes('"')) throw new RevealError("unsupported path", 400)
  return real
}

function command(action: RevealAction, abs: string): { cmd: string; args: string[]; verbatim?: boolean } {
  const target = action === "open" ? abs : path.dirname(abs)
  if (win) {
    // explorer.exe needs the quote after the comma: /select,"C:\a b\c.txt".
    if (action === "reveal") return { cmd: "explorer.exe", args: [`/select,"${abs}"`], verbatim: true }
    return { cmd: "explorer.exe", args: [target] }
  }
  if (process.platform === "darwin") return { cmd: "open", args: action === "reveal" ? ["-R", abs] : [target] }
  return { cmd: "xdg-open", args: [target] }
}

export function reveal(action: RevealAction, abs: string): Promise<void> {
  const { cmd, args, verbatim } = command(action, abs)
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim, shell: false })
    proc.once("error", (err) => {
      slog("workspace", "reveal.failed", { action, cmd, error: err.message }, { level: "warn" })
      reject(new RevealError(`could not start ${cmd}`, 501))
    })
    proc.once("spawn", () => {
      slog("workspace", "reveal.spawned", { action, cmd, path: abs })
      proc.unref()
      resolve()
    })
  })
}
