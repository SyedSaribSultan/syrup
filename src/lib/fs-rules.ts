/**
 * Rules shared by the Files panel and the file routes (local and cloud):
 * which folders are hidden by default, size caps, and workspace-relative
 * path handling. Relative paths always use "/" and never start with one.
 */

/** Folders (and junk files) the tree hides and the zip skips unless "show hidden" is on. */
export const HIDDEN = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".DS_Store",
  "Thumbs.db",
])

/** Cloud zips are built in the workspace (so the browser can read them from the sandbox) and removed right after. */
export const ZIP_DIR = ".syrup-downloads"

/** Never shown, never zipped. */
export const ALWAYS_HIDDEN = new Set([ZIP_DIR])

export const CAPS = {
  previewText: 5 * 1024 * 1024,
  previewBinary: 25 * 1024 * 1024,
  /** Local upload per file. */
  uploadLocal: 200 * 1024 * 1024,
  /** Cloud upload per file; each chunk stays under Vercel's 4.5 MB request limit. */
  uploadCloud: 50 * 1024 * 1024,
  chunkLocal: 8 * 1024 * 1024,
  chunkCloud: 4 * 1024 * 1024,
  zipFiles: 20_000,
  zipBytesLocal: 1024 * 1024 * 1024,
  zipBytesCloud: 150 * 1024 * 1024,
  /** Cloud single-file downloads through a server route (Vercel response limit). */
  rawCloud: 4 * 1024 * 1024,
}

export function isHidden(name: string, showHidden: boolean): boolean {
  return ALWAYS_HIDDEN.has(name) || (!showHidden && HIDDEN.has(name))
}

/**
 * Normalizes a workspace-relative path: "/" separators, no ".", no empty
 * segments. Null for anything that climbs out ("..") or is absolute.
 * "" means the workspace root.
 */
export function cleanRel(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 1024 || raw.includes("\0")) return null
  const p = raw.replace(/\\/g, "/")
  if (p.startsWith("/") || /^[a-z]:/i.test(p)) return null
  const out: string[] = []
  for (const s of p.split("/")) {
    if (!s || s === ".") continue
    if (s === "..") return null
    out.push(s)
  }
  return out.join("/")
}

/** A single file or folder name from an upload: no separators, no dot-only names, no reserved characters. */
export function cleanName(raw: string): string | null {
  const n = raw.trim()
  if (!n || n.length > 255 || n === "." || n === ".." || /[\\/:*?"<>|\0]/.test(n) || /[. ]$/.test(n)) return null
  return n
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf("/")
  return i < 0 ? "" : rel.slice(0, i)
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

/** "report.pdf" → "report (2).pdf" for n = 2. */
export function numbered(name: string, n: number): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? `${name.slice(0, i)} (${n})${name.slice(i)}` : `${name} (${n})`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
