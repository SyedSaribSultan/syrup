import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Config-dir preparation (docs/QUALITY.md, Q0 "hard rule").
 *
 * When OpenCode loads any plugin, it installs `@opencode-ai/plugin` into every config dir it reads
 * (the XDG config dir, each project `.opencode` dir, `~/.opencode`, OPENCODE_CONFIG_DIR) and waits
 * for that install before the first request of a workspace: 21.5 s locally, 56 s in a Vercel
 * Sandbox (measured 2026-10-08 on 1.18.32). A dir that already has a `node_modules` and a
 * `package.json` naming the package is left alone, and the first request takes 0.17–0.34 s.
 *
 * So, before OpenCode starts, each config dir that has neither `node_modules` nor `package.json`
 * gets an empty `node_modules/` plus a `package.json` and `package-lock.json` naming the package.
 * A dir that holds the user's own plugins or tools is never touched: their code needs the real
 * install. Workspaces are never written to (a repo with its own `.opencode` pays the cost once).
 *
 * One implementation for both modes: local mode calls `prepareConfigDirs(localConfigDirs())` in
 * engine/opencode.ts; the sandbox runs the same code as `.sidecar/prepare-config-dirs.js`
 * (sidecar/prepare-config-dirs.ts) right before every `opencode serve`. Node built-ins only.
 */

/** The engine version syrup pins (sandbox install, the plugin package the config dirs name). */
export const OPENCODE_VERSION = "1.18.32"
export const PLUGIN_PACKAGE = "@opencode-ai/plugin"

/** Subfolders OpenCode loads plugin and tool code from (`{plugin,plugins}/*.{js,ts}`, `{tool,tools}/*.{js,ts}`). */
const CODE_DIRS = ["plugin", "plugins", "tool", "tools"]
const CODE_FILE = /\.(m|c)?(j|t)sx?$/i
const CONFIG_FILES = ["opencode.json", "opencode.jsonc"]

/** What is in one config dir, as far as the decision needs it. */
export type DirState = {
  exists: boolean
  /** Names at the top of the dir. */
  entries: string[]
  /** The user's plugin or tool source files (relative paths), and config files that declare plugins. */
  userCode: string[]
}

export type DirAction = "prepare" | "skip"
export type DirReason = "prepared" | "missing" | "has-node-modules" | "has-package-json" | "user-code" | "write-failed"
export type Decision = { action: DirAction; reason: DirReason }

/**
 * The rule, pure. `create`: a dir that doesn't exist yet is created and prepared (the XDG config
 * dir, which OpenCode creates anyway); otherwise a missing dir is left alone (`~/.opencode`).
 */
export function decide(state: DirState, opts: { create: boolean }): Decision {
  if (!state.exists) return opts.create ? { action: "prepare", reason: "prepared" } : { action: "skip", reason: "missing" }
  if (state.entries.includes("node_modules")) return { action: "skip", reason: "has-node-modules" }
  if (state.entries.includes("package.json")) return { action: "skip", reason: "has-package-json" }
  if (state.userCode.length > 0) return { action: "skip", reason: "user-code" }
  return { action: "prepare", reason: "prepared" }
}

/** The two files a prepared dir gets, byte for byte (the Q0 spike's recipe). */
export function seedFiles(version = OPENCODE_VERSION): Record<"package.json" | "package-lock.json", string> {
  const deps = { [PLUGIN_PACKAGE]: version }
  return {
    "package.json": `${JSON.stringify({ dependencies: deps }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify({ lockfileVersion: 3, requires: true, packages: { "": { dependencies: deps } } }, null, 2)}\n`,
  }
}

function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** Reads one dir's state from disk. Never throws. */
export function readDirState(dir: string): DirState {
  let exists = false
  try {
    exists = fs.statSync(dir).isDirectory()
  } catch {}
  if (!exists) return { exists, entries: [], userCode: [] }
  const entries = list(dir)
  const userCode: string[] = []
  for (const sub of CODE_DIRS) {
    if (!entries.includes(sub)) continue
    for (const f of list(path.join(dir, sub))) if (CODE_FILE.test(f)) userCode.push(`${sub}/${f}`)
  }
  for (const f of CONFIG_FILES) {
    if (!entries.includes(f)) continue
    try {
      // A config that names plugins (npm or file) means the user runs plugin code from here.
      if (/"plugin"\s*:/.test(fs.readFileSync(path.join(dir, f), "utf8"))) userCode.push(f)
    } catch {}
  }
  return { exists, entries, userCode }
}

export type DirResult = { dir: string } & Decision & { error?: string }

/** Applies the rule to each dir. Never throws: a dir that can't be written is reported and left as it was. */
export function prepareConfigDirs(dirs: { dir: string; create: boolean }[], version = OPENCODE_VERSION): DirResult[] {
  const seen = new Set<string>()
  const out: DirResult[] = []
  for (const { dir, create } of dirs) {
    const key = process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir)
    if (seen.has(key)) continue
    seen.add(key)
    const d = decide(readDirState(dir), { create })
    if (d.action === "skip") {
      out.push({ dir, ...d })
      continue
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
      for (const [name, text] of Object.entries(seedFiles(version))) fs.writeFileSync(path.join(dir, name), text, { flag: "wx" })
      fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true })
      out.push({ dir, ...d })
    } catch (err) {
      out.push({ dir, action: "skip", reason: "write-failed", error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/**
 * The config dirs local OpenCode reads outside the workspace, resolved the way 1.18.32 resolves
 * them (its Global.Path and ConfigPaths.directories): `$XDG_CONFIG_HOME/opencode`, else
 * `<homedir>/.config/opencode` (on Windows too); `<home>/.opencode`, where home is
 * OPENCODE_TEST_HOME or the homedir; and OPENCODE_CONFIG_DIR when set. Only the XDG one is created.
 */
export function localConfigDirs(env: NodeJS.ProcessEnv = process.env, homedir = os.homedir()): { dir: string; create: boolean }[] {
  const xdg = env.XDG_CONFIG_HOME || path.join(homedir, ".config")
  const home = env.OPENCODE_TEST_HOME ?? homedir
  const out = [
    { dir: path.join(xdg, "opencode"), create: true },
    { dir: path.join(home, ".opencode"), create: false },
  ]
  if (env.OPENCODE_CONFIG_DIR) out.push({ dir: path.resolve(env.OPENCODE_CONFIG_DIR), create: false })
  return out
}

/** The sandbox's config dirs (universal image, HOME=/vercel): the XDG one and the installer's ~/.opencode. */
export const SANDBOX_CONFIG_DIRS = [
  { dir: "/vercel/.config/opencode", create: true },
  { dir: "/vercel/.opencode", create: false },
] as const
