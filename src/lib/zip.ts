/**
 * Minimal streaming ZIP writer (no ZIP64): deflate via CompressionStream,
 * or stored when compression does not help or the format is already
 * compressed. Works in the browser and in Node 20+.
 */

export type ZipEntry = { name: string; data: Uint8Array; mtime?: Date }

const STORE = new Set("png jpg jpeg gif webp avif ico zip gz tgz bz2 xz 7z rar jar war apk mp3 mp4 m4a mov webm ogg woff woff2 pdf whl".split(" "))

let table: Uint32Array | null = null

export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear())
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }
}

function header(size: number, fill: (v: DataView) => void): Uint8Array {
  const b = new Uint8Array(size)
  fill(new DataView(b.buffer))
  return b
}

const enc = new TextEncoder()
const MAX = 0xffffffff

/** Streams a ZIP of the entries, pulled one at a time. Rejects (errors the stream) past 4 GB or 65,535 entries. */
export function zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): ReadableStream<Uint8Array> {
  const central: Uint8Array[] = []
  let offset = 0
  let count = 0
  let it: AsyncIterator<ZipEntry> | Iterator<ZipEntry> | null = null
  let done = false
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (done) return
      it ??= Symbol.asyncIterator in entries ? entries[Symbol.asyncIterator]() : (entries as Iterable<ZipEntry>)[Symbol.iterator]()
      const next = await it.next()
      if (next.done) {
        done = true
        const cd = central.reduce((n, c) => n + c.length, 0)
        for (const c of central) ctrl.enqueue(c)
        ctrl.enqueue(
          header(22, (v) => {
            v.setUint32(0, 0x06054b50, true)
            v.setUint16(8, count, true)
            v.setUint16(10, count, true)
            v.setUint32(12, cd, true)
            v.setUint32(16, offset, true)
          }),
        )
        ctrl.close()
        return
      }
      const { name, data, mtime } = next.value
      if (++count > 0xffff) throw new Error("too many files for a zip")
      const nameBytes = enc.encode(name)
      const crc = crc32(data)
      const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
      let body = data
      let method = 0
      if (data.length > 64 && !STORE.has(ext)) {
        const z = await deflateRaw(data)
        if (z.length < data.length) {
          body = z
          method = 8
        }
      }
      const { time, date } = dosTime(mtime ?? new Date())
      if (offset + 30 + nameBytes.length + body.length > MAX || data.length > MAX) throw new Error("zip is larger than 4 GB")
      const local = header(30, (v) => {
        v.setUint32(0, 0x04034b50, true)
        v.setUint16(4, 20, true)
        v.setUint16(6, 0x0800, true)
        v.setUint16(8, method, true)
        v.setUint16(10, time, true)
        v.setUint16(12, date, true)
        v.setUint32(14, crc, true)
        v.setUint32(18, body.length, true)
        v.setUint32(22, data.length, true)
        v.setUint16(26, nameBytes.length, true)
      })
      const cen = header(46, (v) => {
        v.setUint32(0, 0x02014b50, true)
        v.setUint16(4, 20, true)
        v.setUint16(6, 20, true)
        v.setUint16(8, 0x0800, true)
        v.setUint16(10, method, true)
        v.setUint16(12, time, true)
        v.setUint16(14, date, true)
        v.setUint32(16, crc, true)
        v.setUint32(20, body.length, true)
        v.setUint32(24, data.length, true)
        v.setUint16(28, nameBytes.length, true)
        v.setUint32(42, offset, true)
      })
      central.push(cen, nameBytes)
      ctrl.enqueue(local)
      ctrl.enqueue(nameBytes)
      ctrl.enqueue(body)
      offset += local.length + nameBytes.length + body.length
    },
  })
}
