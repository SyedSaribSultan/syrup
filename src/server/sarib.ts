import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { McpLocalConfig } from "@opencode-ai/sdk/client"
import { engine } from "./engine/opencode"
import { slog } from "./log"

/**
 * Optional .sarib tools (https://github.com/SyedSaribSultan/sarib-lang).
 *
 * The `sarib` MCP server is added per workspace, only to folders that contain
 * .sarib files, so other workspaces never pay for its tool definitions.
 * OpenCode keeps MCP state per directory and runs local servers in that
 * directory, so the server sees exactly that workspace's files.
 *
 * It needs Python 3.10+ and `pip install "sarib[mcp]"`; install() runs that.
 */

const run = promisify(execFile)
const RESCAN_MS = 60_000
const MAX_DEPTH = 3
const MAX_ENTRIES = 5_000
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "out", ".venv", "venv", "__pycache__", "target", ".turbo", ".cache"])

export type SaribStatus = {
  /** Python 3.10+ found, as the argv prefix that runs it. */
  python: string[] | null
  /** Command that starts the MCP server, or null when not installed. */
  command: string[] | null
  installing: boolean
  /** Tail of the last pip run. */
  log: string
  error: string | null
}

type State = {
  probe?: Promise<{ python: string[] | null; command: string[] | null }>
  installing: boolean
  log: string
  error: string | null
  /** directory -> last scan time and result */
  scanned: Map<string, { at: number; has: boolean }>
}

const g = globalThis as unknown as { __syrupSarib?: State }
const state: State = (g.__syrupSarib ??= { installing: false, log: "", error: null, scanned: new Map() })

function onPath(name: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    // The Microsoft Store "python" stub opens the Store instead of running.
    if (!dir || /WindowsApps/i.test(dir)) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase())
      if (existsSync(p)) return p
    }
  }
  return null
}

async function findPython(): Promise<string[] | null> {
  const candidates: string[][] = []
  if (process.platform === "win32") {
    const py = onPath("py")
    if (py) candidates.push([py, "-3"])
    const python = onPath("python")
    if (python) candidates.push([python])
  } else {
    for (const n of ["python3", "python"]) {
      const p = onPath(n)
      if (p) candidates.push([p])
    }
  }
  for (const [exe, ...pre] of candidates) {
    try {
      const { stdout } = await run(exe, [...pre, "-c", "import sys;print(sys.version_info>=(3,10))"], { timeout: 15_000, windowsHide: true })
      if (stdout.trim() === "True") return [exe, ...pre]
    } catch {}
  }
  return null
}

async function probe(): Promise<{ python: string[] | null; command: string[] | null }> {
  const python = await findPython()
  const bin = onPath("sarib-mcp")
  if (bin) return { python, command: [bin] }
  if (!python) return { python, command: null }
  // pip --user scripts are often not on PATH; the module form works regardless.
  try {
    const [exe, ...pre] = python
    const check = "import importlib.util as u,sys;sys.exit(0 if u.find_spec('mcp') and u.find_spec('sarib') else 1)"
    await run(exe, [...pre, "-c", check], { timeout: 15_000, windowsHide: true })
    return { python, command: [...python, "-m", "sarib.mcp_server"] }
  } catch {
    return { python, command: null }
  }
}

function probed() {
  state.probe ??= probe().then((r) => {
    slog("mcp", "sarib.probe", r)
    return r
  })
  return state.probe
}

export async function saribStatus(): Promise<SaribStatus> {
  const { python, command } = await probed()
  return { python, command, installing: state.installing, log: state.log.slice(-4000), error: state.error }
}

/** Runs `pip install --user "sarib[mcp]"` in the background. */
export async function installSarib(): Promise<SaribStatus> {
  if (state.installing) return saribStatus()
  const { python } = await probed()
  if (!python) {
    state.error = "Python 3.10+ was not found. Install it from https://www.python.org/downloads/ and try again."
    return saribStatus()
  }
  state.installing = true
  state.error = null
  state.log = ""
  const [exe, ...pre] = python
  const args = [...pre, "-m", "pip", "install", "--user", "--upgrade", "--disable-pip-version-check", "sarib[mcp]"]
  slog("mcp", "sarib.install.start", { exe, args })
  const proc = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  proc.stdout.on("data", (c) => (state.log += c))
  proc.stderr.on("data", (c) => (state.log += c))
  proc.on("error", (e) => {
    state.installing = false
    state.error = e.message
    slog("mcp", "sarib.install.error", e, { level: "error" })
  })
  proc.on("exit", (code) => {
    state.installing = false
    state.probe = undefined
    state.scanned.clear()
    if (code !== 0) state.error = `pip exited with code ${code}. See the log below.`
    slog("mcp", "sarib.install.exit", { code, log: state.log.slice(-2000) }, { level: code === 0 ? "info" : "warn" })
  })
  return saribStatus()
}

/** True when the folder has a .sarib file within a few levels, skipping build and dependency folders. */
async function hasSaribFiles(root: string): Promise<boolean> {
  let seen = 0
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    const subdirs: string[] = []
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return false
      if (e.isFile() && e.name.endsWith(".sarib")) return true
      if (e.isDirectory() && depth < MAX_DEPTH && !SKIP.has(e.name) && !e.name.startsWith(".")) subdirs.push(path.join(dir, e.name))
    }
    for (const d of subdirs) if (await walk(d, depth + 1)) return true
    return false
  }
  return walk(root, 0)
}

const inflight = new Map<string, Promise<void>>()

/**
 * Adds the sarib MCP server to this directory's engine instance when the
 * folder has .sarib files and sarib is installed. Cheap to call often: the
 * folder is rescanned at most once a minute.
 */
export function ensureSarib(directory: string): Promise<void> {
  const dir = path.resolve(directory)
  const last = state.scanned.get(dir)
  if (last && Date.now() - last.at < RESCAN_MS) return Promise.resolve()
  let p = inflight.get(dir)
  if (!p) {
    p = (async () => {
      const has = await hasSaribFiles(dir)
      state.scanned.set(dir, { at: Date.now(), has })
      if (!has) return
      const { command } = await probed()
      if (!command) return
      const { client } = await engine()
      const status = await client.mcp.status({ query: { directory } })
      const current = (status.data as Record<string, { status: string }> | undefined)?.sarib?.status
      if (current === "connected") return
      if (!current) {
        const config: McpLocalConfig = { type: "local", command, enabled: true, timeout: 15_000 }
        const res = await client.mcp.add({ query: { directory }, body: { name: "sarib", config } })
        if (res.error) return void slog("mcp", "sarib.add_failed", { dir, command, error: res.error }, { level: "warn", directory: dir })
      }
      // mcp.add registers the server but can leave it disabled; connect starts it.
      const res = await client.mcp.connect({ path: { name: "sarib" }, query: { directory } })
      slog("mcp", res.error ? "sarib.connect_failed" : "sarib.connected", { dir, command, error: res.error }, { level: res.error ? "warn" : "info", directory: dir })
    })()
      .catch((err) => slog("mcp", "sarib.ensure_error", err, { level: "warn", directory: dir }))
      .finally(() => inflight.delete(dir))
    inflight.set(dir, p)
  }
  return p
}
