import { ALWAYS_HIDDEN, CAPS, HIDDEN } from "@/lib/fs-rules"

/**
 * Cloud "Download as .zip": a self-contained Node script run inside the
 * sandbox (Node is always there, the sidecar needs it). It zips a folder of
 * the workspace into <root>/.syrup-downloads/<id>.zip, which the browser then
 * reads straight from the sandbox's engine (no Vercel body limits) and asks
 * the server to delete. Arguments go through argv, never a shell.
 *
 * argv: root, rel, out, showHidden ("1"/"0"), hidden (JSON), alwaysHidden (JSON), maxFiles, maxBytes
 * stdout: {"count":n,"bytes":n} or {"error":"..."}
 */
export const ZIP_SCRIPT = String.raw`
const fs = require("fs"), path = require("path"), zlib = require("zlib")
const [root, rel, out, showHidden, hiddenJson, alwaysJson, maxFiles, maxBytes] = process.argv.slice(1)
const HIDDEN = new Set(JSON.parse(hiddenJson)), ALWAYS = new Set(JSON.parse(alwaysJson))
const skip = (n) => ALWAYS.has(n) || (showHidden !== "1" && HIDDEN.has(n))
const STORE = new Set("png jpg jpeg gif webp avif ico zip gz tgz bz2 xz 7z rar jar war apk mp3 mp4 m4a mov webm ogg woff woff2 pdf whl".split(" "))
let T = null
const crc = zlib.crc32 ? (b) => zlib.crc32(b) >>> 0 : (b) => {
  if (!T) { T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c } }
  let c = -1; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0
}
const done = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0) }
const realRoot = fs.realpathSync(root)
const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep)
let start
try { start = fs.realpathSync(path.resolve(root, rel)) } catch { done({ error: "not found" }) }
if (!inside(start)) done({ error: "path is outside the workspace" })
const files = []
let total = 0
function walk(dir, prefix) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip(d.name) || d.isSymbolicLink()) continue
    const abs = path.join(dir, d.name), name = prefix ? prefix + "/" + d.name : d.name
    if (d.isDirectory()) walk(abs, name)
    else if (d.isFile()) {
      const st = fs.lstatSync(abs)
      files.push({ abs, name, mtime: st.mtime })
      total += st.size
      if (files.length > +maxFiles) done({ error: "more than " + maxFiles + " files, too many for one zip" })
      if (total > +maxBytes) done({ error: "over " + Math.round(maxBytes / 1048576) + " MB, too big to download at once. Try a smaller folder." })
    }
  }
}
const st = fs.statSync(start)
if (st.isDirectory()) walk(start, "")
else files.push({ abs: start, name: path.basename(start), mtime: st.mtime })
const zdir = path.dirname(out)
fs.mkdirSync(zdir, { recursive: true })
fs.writeFileSync(path.join(zdir, ".gitignore"), "*\n")
for (const f of fs.readdirSync(zdir)) {
  const p = path.join(zdir, f)
  if (f.endsWith(".zip") && Date.now() - fs.statSync(p).mtimeMs > 10 * 60000) fs.rmSync(p, { force: true })
}
const fd = fs.openSync(out, "w")
const central = []
let offset = 0
for (const f of files) {
  let data
  try { data = fs.readFileSync(f.abs) } catch { continue }
  const name = Buffer.from(f.name, "utf8"), c = crc(data)
  let body = data, method = 0
  if (data.length > 64 && !STORE.has(path.extname(f.name).slice(1).toLowerCase())) {
    const z = zlib.deflateRawSync(data)
    if (z.length < data.length) { body = z; method = 8 }
  }
  const d = f.mtime, y = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8)
  h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(c, 14); h.writeUInt32LE(body.length, 18)
  h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26)
  const e = Buffer.alloc(46)
  e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0x0800, 8)
  e.writeUInt16LE(method, 10); e.writeUInt16LE(time, 12); e.writeUInt16LE(date, 14); e.writeUInt32LE(c, 16)
  e.writeUInt32LE(body.length, 20); e.writeUInt32LE(data.length, 24); e.writeUInt16LE(name.length, 28); e.writeUInt32LE(offset, 42)
  central.push(e, name)
  fs.writeSync(fd, h); fs.writeSync(fd, name); fs.writeSync(fd, body)
  offset += 30 + name.length + body.length
}
const cd = Buffer.concat(central)
const end = Buffer.alloc(22)
const n = central.length / 2
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
fs.writeSync(fd, cd); fs.writeSync(fd, end); fs.closeSync(fd)
done({ count: n, bytes: offset + cd.length + 22 })
`

export function zipScriptArgs(root: string, rel: string, out: string, showHidden: boolean): string[] {
  return ["-e", ZIP_SCRIPT, root, rel || ".", out, showHidden ? "1" : "0", JSON.stringify([...HIDDEN]), JSON.stringify([...ALWAYS_HIDDEN]), String(CAPS.zipFiles), String(CAPS.zipBytesCloud)]
}
