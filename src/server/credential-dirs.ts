import os from "node:os"
import nodePath from "node:path"
import fs from "node:fs"
import { env } from "./env"

/**
 * Folders the browser must never reach, local mode: OpenCode's data folder (auth.json: provider keys in plain text),
 * its config and state folders (XDG locations, which OpenCode uses on every OS), and syrup's own config folder
 * (vault.key, which unseals every key in syrup's database). The engine proxy (/api/oc) refuses them as a session's
 * folder or a file-list path; the local file routes (/api/workspace/files, /api/workspace/reveal) refuse any path
 * that resolves into them, and a zip skips them.
 *
 * Whole folders, on purpose: OpenCode's config folder also holds opencode.json (provider keys, MCP headers), so its
 * skills/ and AGENTS.md are refused with it. Only a workspace that is the home folder itself notices; skills are
 * managed on the Skills page.
 *
 * A path is compared two ways, so no spelling of it gets around the check:
 * - **By name**, after links are resolved (realpath), without case on Windows.
 * - **By identity** (device and file id): the target and each folder above it against the credential folders, and the
 *   target against the files at the top of those folders (auth.json, mcp-auth.json, opencode.json, vault.key). That
 *   catches what a name can't: a hard link to auth.json elsewhere, or a second way to spell the same volume.
 * - **Windows:** only paths on a drive letter (C:\…), before and after realpath. realpath keeps a UNC path as it is,
 *   so "\\127.0.0.1\c$\Users\…" (an admin share of this very disk) would otherwise never match C:\Users\….
 */

export const CREDENTIALS_REFUSED = "That folder holds syrup's or the engine's credentials, so the browser can't open it."
export const NOT_LOCAL_DRIVE = "syrup only opens folders on this computer's own drives (like C:\\), not network or device paths (\\\\…)."

const win = process.platform === "win32"
const DRIVE = /^[A-Za-z]:\\/

function realpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/** A path as the filesystem resolves it, for comparing: links followed in the part that exists, the rest appended. */
export function realish(p: string): string {
  const abs = nodePath.resolve(p)
  const tail: string[] = []
  for (let cur = abs; ; ) {
    const real = realpath(cur)
    if (real) return tail.length ? nodePath.join(real, ...tail.reverse()) : real
    const up = nodePath.dirname(cur)
    if (up === cur) return abs
    tail.push(nodePath.basename(cur))
    cur = up
  }
}

/**
 * Windows: `p` is on a drive letter of this computer, spelled that way and still so after realpath. Refuses UNC paths
 * (\\server\share, \\127.0.0.1\c$), \\?\ and \\.\ device paths, and a link or mapped drive that leads to one. Elsewhere
 * always true.
 */
export function isLocalDrivePath(p: string): boolean {
  if (!win) return true
  const abs = nodePath.resolve(p)
  return DRIVE.test(abs) && DRIVE.test(realish(abs))
}

/** `p` is `parent` or inside it (path.relative compares without case on Windows). */
function inside(p: string, parent: string): boolean {
  const rel = nodePath.relative(parent, p)
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel))
}

let dirs: string[] | null = null
export function credentialDirs(): string[] {
  if (dirs) return dirs
  const home = os.homedir()
  const xdg = (name: string, ...fallback: string[]) => process.env[name] || nodePath.join(home, ...fallback)
  dirs = [
    nodePath.join(xdg("XDG_DATA_HOME", ".local", "share"), "opencode"),
    nodePath.join(xdg("XDG_CONFIG_HOME", ".config"), "opencode"),
    nodePath.join(xdg("XDG_STATE_HOME", ".local", "state"), "opencode"),
    env.configDir,
  ].map(realish)
  return dirs
}

/** Device and file id, links followed; null when missing or when the filesystem has no file ids (ino 0). */
function idOf(p: string): string | null {
  try {
    const s = fs.statSync(p, { bigint: true })
    return s.ino === BigInt(0) ? null : `${s.dev}:${s.ino}`
  } catch {
    return null
  }
}

type Ids = { dirs: Set<string>; files: Set<string>; at: number }
let ids: Ids | null = null

/** Identities of the credential folders and of the files at their top level. Re-read every 2 s: auth.json is rewritten in place of the old one. */
function credentialIds(): Ids {
  if (ids && Date.now() - ids.at < 2_000) return ids
  const next: Ids = { dirs: new Set(), files: new Set(), at: Date.now() }
  for (const d of credentialDirs()) {
    const id = idOf(d)
    if (!id) continue
    next.dirs.add(id)
    let list: fs.Dirent[] = []
    try {
      list = fs.readdirSync(d, { withFileTypes: true })
    } catch {}
    for (const e of list) {
      if (!e.isFile()) continue
      const f = idOf(nodePath.join(d, e.name))
      if (f) next.files.add(f)
    }
  }
  ids = next
  return next
}

/** `p` (resolved through links) is one of those folders, inside one, or one of their top-level files under another name. A path that isn't a plain local-drive path counts as one (fail closed). */
export function isCredentialPath(p: string): boolean {
  if (!isLocalDrivePath(p)) return true
  const t = realish(p)
  if (credentialDirs().some((c) => inside(t, c))) return true
  const known = credentialIds()
  const own = idOf(t)
  if (own && known.files.has(own)) return true
  for (let cur = t; ; ) {
    const id = cur === t ? own : idOf(cur)
    if (id && known.dirs.has(id)) return true
    const up = nodePath.dirname(cur)
    if (up === cur) return false
    cur = up
  }
}

/** `dir`, or `rel` resolved inside it, is in (or is) a folder that holds credentials. */
export function reachesCredentials(dir: string, rel?: string | null): boolean {
  if (isCredentialPath(dir)) return true
  return !!rel && isCredentialPath(nodePath.resolve(realish(dir), rel))
}

/**
 * For walking a tree whose root already passed isCredentialPath (a zip): one stat per entry instead of a walk up to
 * the drive root. `dir` for real folders met on the way; `file` for files with more than one link (a hard link).
 */
export function credentialFilter(): { dir(abs: string): boolean; file(abs: string): boolean } {
  const names = credentialDirs()
  const known = credentialIds()
  return {
    dir: (abs) => {
      if (names.some((c) => inside(abs, c))) return true
      const id = idOf(abs)
      return !!id && known.dirs.has(id)
    },
    file: (abs) => {
      const id = idOf(abs)
      return !!id && known.files.has(id)
    },
  }
}
