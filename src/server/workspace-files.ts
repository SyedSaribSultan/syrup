import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { CAPS, cleanName, cleanRel, isHidden, numbered, parentRel } from "@/lib/fs-rules"
import { zipStream, type ZipEntry } from "@/lib/zip"
import { credentialFilter, CREDENTIALS_REFUSED, isCredentialPath } from "./credential-dirs"
import { resolveInWorkspace, RevealError } from "./reveal"

/**
 * Files panel, local mode: stat, raw bytes, zip and upload for a workspace
 * folder on this machine. Every path is workspace-relative, resolved with
 * resolveInWorkspace (realpath inside the workspace, never a drive root,
 * never a credential folder or file). Symlinks are never followed when zipping,
 * and a zip skips credential folders and hard links to credential files.
 */

export { RevealError as FilesError }

function rel(raw: string | null): string {
  const r = cleanRel(raw ?? "")
  if (r === null) throw new RevealError("bad path", 400)
  return r
}

export function statFile(workspace: string, raw: string | null): { size: number; type: "file" | "directory"; mtime: number } {
  const abs = resolveInWorkspace(workspace, rel(raw))
  const st = fs.statSync(abs)
  return { size: st.size, type: st.isDirectory() ? "directory" : "file", mtime: st.mtimeMs }
}

/** The file's exact bytes, as octet-stream with nosniff and a sandbox CSP: opening the URL never renders it on syrup's origin. */
export function rawFile(workspace: string, raw: string | null): Response {
  const abs = resolveInWorkspace(workspace, rel(raw))
  const st = fs.statSync(abs)
  if (!st.isFile()) throw new RevealError("not a file", 400)
  const body = Readable.toWeb(fs.createReadStream(abs)) as ReadableStream<Uint8Array>
  return new Response(body, { headers: fileHeaders(st.size) })
}

// No Content-Disposition: attachment. Chrome can divert a fetch() carrying it into a download and hand the page an empty 204.
export function fileHeaders(size?: number): Headers {
  const h = new Headers({
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    "cache-control": "no-store",
  })
  if (size !== undefined) h.set("content-length", String(size))
  return h
}

type Found = { abs: string; name: string; size: number; mtime: Date }

type Creds = ReturnType<typeof credentialFilter>

async function walk(root: string, prefix: string, showHidden: boolean, out: Found[], total: { bytes: number }, creds: Creds) {
  const list = await fs.promises.readdir(root, { withFileTypes: true })
  for (const d of list) {
    if (isHidden(d.name, showHidden) || d.isSymbolicLink()) continue
    const abs = path.join(root, d.name)
    const name = prefix ? `${prefix}/${d.name}` : d.name
    // A zip of the home folder would otherwise carry the engine's auth.json and syrup's vault key. Links are
    // skipped and the root is a real path, so a file reaches one only through its folder, or as a hard link.
    if (d.isDirectory()) {
      if (!creds.dir(abs)) await walk(abs, name, showHidden, out, total, creds)
    } else if (d.isFile()) {
      const st = await fs.promises.lstat(abs)
      if (st.nlink > 1 && creds.file(abs)) continue
      out.push({ abs, name, size: st.size, mtime: st.mtime })
      total.bytes += st.size
      if (out.length > CAPS.zipFiles) throw new RevealError(`more than ${CAPS.zipFiles.toLocaleString()} files, too many for one zip`, 413)
      if (total.bytes > CAPS.zipBytesLocal) throw new RevealError("over 1 GB, too big for one zip", 413)
    }
  }
}

/** A zip of a folder (or one file), skipping hidden folders unless asked. The whole tree is checked against the caps before the first byte goes out. */
export async function zipFolder(workspace: string, raw: string | null, showHidden: boolean): Promise<Response> {
  const r = rel(raw)
  const abs = resolveInWorkspace(workspace, r)
  const st = fs.statSync(abs)
  const found: Found[] = []
  if (st.isDirectory()) await walk(abs, "", showHidden, found, { bytes: 0 }, credentialFilter())
  else found.push({ abs, name: path.basename(abs), size: st.size, mtime: st.mtime })
  async function* entries(): AsyncGenerator<ZipEntry> {
    for (const f of found) {
      const data = await fs.promises.readFile(f.abs).catch(() => null)
      if (data) yield { name: f.name, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mtime: f.mtime }
    }
  }
  const h = fileHeaders()
  h.set("x-file-count", String(found.length))
  return new Response(zipStream(entries()), { headers: h })
}

const TEMP = (name: string) => `.${name}.syrup-upload`

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Creates the missing folders of `dir` one at a time, each checked to still be inside the workspace. */
function ensureDir(workspace: string, dir: string): string {
  let cur = resolveInWorkspace(workspace, "")
  let sofar = ""
  for (const seg of dir ? dir.split("/") : []) {
    if (!cleanName(seg)) throw new RevealError("bad folder name", 400)
    sofar = sofar ? `${sofar}/${seg}` : seg
    const next = path.join(cur, seg)
    // Checked before mkdir too: an upload must not even create a folder where the engine reads its config.
    if (isCredentialPath(next)) throw new RevealError(CREDENTIALS_REFUSED, 403)
    if (!exists(next)) fs.mkdirSync(next)
    cur = resolveInWorkspace(workspace, sofar)
    if (!fs.statSync(cur).isDirectory()) throw new RevealError(`${seg} is a file`, 409)
  }
  return cur
}

/**
 * One chunk of an upload. The first chunk (offset 0) picks a free name next
 * to the target ("a (2).txt" when "a.txt" exists) and returns it; later chunks
 * send that name back. Bytes go to a hidden temp file that is renamed when the
 * last chunk lands.
 */
export async function uploadChunk(workspace: string, target: string | null, offset: number, total: number, body: Uint8Array): Promise<{ path: string; done: boolean }> {
  const r = rel(target)
  const name = cleanName(r.split("/").pop() ?? "")
  if (!r || !name) throw new RevealError("bad file name", 400)
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || offset < 0 || total < 0 || offset + body.length > total) throw new RevealError("bad chunk", 400)
  if (total > CAPS.uploadLocal) throw new RevealError("file is over 200 MB", 413)
  if (body.length > CAPS.chunkLocal) throw new RevealError("chunk too big", 413)
  const dirRel = parentRel(r)
  const dir = ensureDir(workspace, dirRel)
  let final = name
  if (offset === 0) {
    for (let n = 2; exists(path.join(dir, final)); n++) {
      if (n > 200) throw new RevealError("too many files with that name", 409)
      final = numbered(name, n)
    }
  }
  const temp = path.join(dir, TEMP(final))
  // lstat, and "wx" on create: a planted symlink at the temp name is never written through.
  if (offset === 0) {
    if (exists(temp)) fs.unlinkSync(temp)
    fs.writeFileSync(temp, body, { flag: "wx" })
  } else {
    const st = fs.lstatSync(temp, { throwIfNoEntry: false })
    if (!st?.isFile() || st.size !== offset) throw new RevealError("upload out of order, start again", 409)
    fs.appendFileSync(temp, body)
  }
  const done = offset + body.length === total
  if (done) {
    let dest = final
    for (let n = 2; exists(path.join(dir, dest)); n++) dest = numbered(final, n)
    fs.renameSync(temp, path.join(dir, dest))
    final = dest
  }
  return { path: dirRel ? `${dirRel}/${final}` : final, done }
}
