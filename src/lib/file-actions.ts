"use client"

import { oc, type Connection, type FileContent } from "./oc"

/**
 * File mentions in chats: what counts as a path, how it resolves against the
 * workspace, and what can be done with it. Paths use the workspace's own
 * separator style (backslashes for a Windows folder, slashes otherwise).
 */

export type WorkspaceFile = { abs: string; rel: string; name: string; line?: number }

const EXT = new Set(
  (
    "py pyw pyi ipynb ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx txt rst html htm css scss sass less vue svelte astro " +
    "yml yaml toml ini cfg conf env lock sql db sqlite prisma graphql gql proto go rs java kt kts scala c h cc cpp hpp cxx cs fs rb php " +
    "swift mm dart lua pl ex exs erl zig nim sh bash zsh fish ps1 psm1 bat cmd exe msi dll so dylib wasm bin app apk jar war " +
    "spec xml csv tsv log pdf png jpg jpeg gif svg webp ico bmp mp3 mp4 wav mov zip tar gz tgz 7z rar gradle properties tf hcl " +
    "dockerfile makefile mk cmake patch diff pem crt key pub gitignore gitattributes editorconfig npmrc nvmrc map"
  ).split(" "),
)
const NAMES = new Set(["dockerfile", "makefile", "procfile", "gemfile", "rakefile", "license", "readme", "changelog", "agents.md", "claude.md"])
// Library names that look like files in prose: Next.js, Node.js.
const NOT_FILES = /^(next|node|react|vue|nuxt|three|express|deno|chart|socket\.io|d3|p5|alpine|ember|backbone|moment)\.js$/i
// Extensions that are usually property access when there is no folder: console.log, process.env.
const BARE_AMBIGUOUS = new Set(["log", "map", "key", "pub", "app", "bin", "env", "lock", "spec", "patch", "diff"])
const SEGMENT = /^[\p{L}\p{N}_.@+\-[\]]+$/u
const EXEC = new Set(["exe", "msi", "bat", "cmd", "com", "scr", "ps1", "psm1", "vbs", "vbe", "wsf", "jse", "lnk", "reg", "sh", "bash", "zsh", "command", "app", "appimage", "jar", "run", "bin", "apk"])
// Windows runs these with an interpreter when "opened".
const EXEC_WIN = new Set(["js", "py", "pyw"])

export function isWindowsPath(dir: string): boolean {
  return /^[a-z]:[\\/]/i.test(dir) || dir.includes("\\")
}

function isAbsolute(p: string, win: boolean): boolean {
  return win ? /^[a-z]:[\\/]/i.test(p) : p.startsWith("/")
}

function normalize(p: string, win: boolean): string {
  const sep = win ? "\\" : "/"
  const out: string[] = []
  const parts = p.split(/[\\/]+/)
  for (const [i, s] of parts.entries()) {
    if (s === "." || (s === "" && i > 0)) continue
    if (s === ".." && out.length > 1) out.pop()
    else if (s !== "..") out.push(s)
  }
  const joined = out.join(sep)
  return win ? joined.replace(/^([a-z]):$/i, "$1:\\") : joined || "/"
}

function inside(dir: string, abs: string, win: boolean): boolean {
  const a = win ? dir.toLowerCase() : dir
  const b = win ? abs.toLowerCase() : abs
  const sep = win ? "\\" : "/"
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)
}

export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

/** Resolves any path (absolute or relative) against the workspace. Null when it lands outside it. */
export function resolveFile(dir: string, raw: string): WorkspaceFile | null {
  if (!dir) return null
  const win = isWindowsPath(dir)
  const m = raw.match(/^(.*?)(?::(\d+))?(?::\d+)?$/)
  const p = m?.[1] || raw
  const root = normalize(dir, win)
  const abs = normalize(isAbsolute(p, win) ? p : `${root}${win ? "\\" : "/"}${p}`, win)
  if (!inside(root, abs, win)) return null
  const rel = abs.length > root.length ? abs.slice(root.length).replace(/^[\\/]/, "") : "."
  return { abs, rel, name: baseName(abs), line: m?.[2] ? Number(m[2]) : undefined }
}

/**
 * Conservative check for inline code that is a single file path: `app.py`,
 * `dist\app.exe`, `src/app.ts:42`, `sidecar/`. Not commands, URLs, globs or identifiers.
 */
export function filePathIn(token: string, dir: string): WorkspaceFile | null {
  const t = token.trim()
  if (!t || t.length > 300 || /\s|:\/\/|[*?<>|"'`(){}=,;$%^!#&~]/.test(t) || /^[@-]/.test(t)) return null
  const p = t.replace(/:\d+(?::\d+)?$/, "")
  if (/:/.test(p.replace(/^[a-z]:(?=[\\/])/i, ""))) return null
  const segs = p.split(/[\\/]/)
  const last = segs[segs.length - 1]
  const hasSep = segs.length > 1
  if (segs.slice(1, -1).some((s) => !s) || segs.some((s, i) => s && !SEGMENT.test(s) && !(i === 0 && /^[a-z]:$/i.test(s)))) return null
  if (last === "") {
    if (!hasSep || !segs[segs.length - 2]) return null
  } else {
    const lower = last.toLowerCase()
    const ext = extOf(last)
    const known = NAMES.has(lower) || (EXT.has(ext) && /[a-z]/i.test(last.slice(0, last.lastIndexOf(".")) || "x")) || /^\.(env(\..+)?|git\w+|npmrc|nvmrc|editorconfig|dockerignore|prettierrc.*|eslintrc.*)$/i.test(last)
    if (!known || (!hasSep && (NOT_FILES.test(last) || BARE_AMBIGUOUS.has(ext)))) return null
  }
  return resolveFile(dir, t)
}

export function isExecutable(name: string, win: boolean): boolean {
  const ext = extOf(name)
  return EXEC.has(ext) || (win && EXEC_WIN.has(ext))
}

export type HostOS = "windows" | "mac" | "linux"

export function hostOS(): HostOS {
  const p = (typeof navigator === "undefined" ? "" : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform)).toLowerCase()
  return p.startsWith("win") ? "windows" : p.startsWith("mac") ? "mac" : "linux"
}

export function revealLabel(os: HostOS): string {
  return os === "windows" ? "Show in File Explorer" : os === "mac" ? "Show in Finder" : "Show in folder"
}

export type LocalAction = "reveal" | "open" | "folder"

/** Local mode: asks the server to show or open a file on this machine. Resolves to an error message, "missing", or null. */
export async function localFileAction(workspace: string, path: string, action: LocalAction): Promise<"missing" | string | null> {
  try {
    const r = await fetch("/api/workspace/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace, path, action }) })
    if (r.ok) return null
    if (r.status === 404) return "missing"
    const j = await r.json().catch(() => null)
    return j?.error ?? `Failed (${r.status})`
  } catch {
    return "Could not reach syrup"
  }
}

export type FileBody = { kind: "text"; text: string } | { kind: "binary"; bytes: Uint8Array<ArrayBuffer>; mime?: string }

/** Cloud mode: whether a file exists, from its parent folder's listing in the sandbox. */
export async function cloudExists(dir: string, conn: Connection | null, f: WorkspaceFile): Promise<boolean> {
  if (f.rel === ".") return true
  const parent = f.rel.includes("/") || f.rel.includes("\\") ? f.rel.slice(0, Math.max(f.rel.lastIndexOf("/"), f.rel.lastIndexOf("\\"))) : "."
  const r = await oc(dir, conn)
    .file.list({ query: { path: parent } })
    .catch(() => null)
  return !!r?.data?.some((e) => e.name === f.name)
}

/** Cloud mode: a file's contents, read through the sandbox's engine. */
export async function cloudRead(dir: string, conn: Connection | null, f: WorkspaceFile): Promise<FileBody | null> {
  const r = await oc(dir, conn)
    .file.read({ query: { path: f.rel } })
    .catch(() => null)
  return r?.data ? bodyOf(r.data) : null
}

/** An engine file read as text or bytes. The engine trims text files, so text is not byte-exact. */
export function bodyOf(d: FileContent): FileBody {
  if (d.type === "text" && d.encoding !== "base64") return { kind: "text", text: d.content }
  const bin = atob(d.content)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { kind: "binary", bytes, mime: d.mimeType }
}

export function download(name: string, body: FileBody) {
  saveBlob(name, body.kind === "text" ? new Blob([body.text], { type: "text/plain;charset=utf-8" }) : new Blob([body.bytes], { type: body.mime || "application/octet-stream" }))
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text })
    document.body.appendChild(ta)
    ta.select()
    document.execCommand("copy")
    ta.remove()
  }
}

export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
