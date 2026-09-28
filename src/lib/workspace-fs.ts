"use client"

import { bodyOf, saveBlob, type FileBody } from "./file-actions"
import { CAPS, cleanName, extOf, fmtBytes, isHidden, joinRel } from "./fs-rules"
import { oc, type Connection } from "./oc"

/**
 * The Files panel's file access, one API for both modes. Paths are
 * workspace-relative with "/".
 * - Local: listing through the engine; reads, zips and uploads through
 *   /api/workspace/files (exact bytes from disk).
 * - Cloud: listing and reads straight from the sandbox's engine; zips and
 *   uploads through /api/workspaces/:id/files (sandbox SDK).
 */

export type Target = { dir: string; conn: Connection | null; workspaceId: string | null }
export type Entry = { name: string; rel: string; type: "file" | "directory"; ignored: boolean }

export class FsError extends Error {}

const cloud = (t: Target) => !!t.workspaceId

function localUrl(t: Target, q: Record<string, string>): string {
  return `/api/workspace/files?${new URLSearchParams({ workspace: t.dir, ...q })}`
}

function cloudUrl(t: Target, q: Record<string, string>): string {
  return `/api/workspaces/${t.workspaceId}/files?${new URLSearchParams(q)}`
}

async function failure(r: Response): Promise<FsError> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null
  return new FsError(j?.error ?? `Failed (${r.status})`)
}

export function absPath(t: Target, rel: string): string {
  if (!rel) return t.dir
  const win = /^[a-z]:[\\/]/i.test(t.dir) || t.dir.includes("\\")
  const sep = win ? "\\" : "/"
  return `${t.dir.replace(/[\\/]+$/, "")}${sep}${win ? rel.replace(/\//g, "\\") : rel}`
}

export async function list(t: Target, rel: string, showHidden: boolean): Promise<Entry[]> {
  const r = await oc(t.dir, t.conn)
    .file.list({ query: { path: rel || "." } })
    .catch(() => null)
  if (!r?.data) throw new FsError("Couldn't read this folder")
  return r.data
    .filter((n) => !isHidden(n.name, showHidden) && !/^\..+\.syrup-upload$/.test(n.name))
    .map((n): Entry => ({ name: n.name, rel: joinRel(rel, n.name), type: n.type, ignored: n.ignored }))
    .sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
}

const BINARY = new Set("png jpg jpeg gif webp avif ico bmp pdf zip gz tgz 7z rar exe dll so dylib bin wasm mp3 mp4 wav mov webm ogg woff woff2 ttf otf pyc class jar sqlite db".split(" "))
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp", svg: "image/svg+xml", pdf: "application/pdf" }

export function mimeOf(name: string): string | undefined {
  return MIME[extOf(name)]
}

/** Bytes → text when they look like text (valid UTF-8, no NULs up front). */
function decode(bytes: Uint8Array<ArrayBuffer>, name: string): FileBody {
  const ext = extOf(name)
  if (!BINARY.has(ext) && !bytes.subarray(0, 8192).includes(0)) {
    try {
      return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "") }
    } catch {}
  }
  return { kind: "binary", bytes, mime: mimeOf(name) }
}

export type Read = { body: FileBody; size: number } | { tooBig: number }

/** A file for preview. Local mode checks the size first; cloud mode can only tell after reading. */
export async function read(t: Target, rel: string, name: string): Promise<Read> {
  const binaryish = BINARY.has(extOf(name))
  const cap = binaryish ? CAPS.previewBinary : CAPS.previewText
  if (!cloud(t)) {
    const st = await fetch(localUrl(t, { op: "stat", path: rel }))
    if (!st.ok) throw await failure(st)
    const { size } = (await st.json()) as { size: number }
    if (size > cap) return { tooBig: size }
    const r = await fetch(localUrl(t, { op: "raw", path: rel }))
    if (!r.ok) throw await failure(r)
    const bytes = new Uint8Array(await r.arrayBuffer())
    const body = decode(bytes, name)
    if (body.kind === "text" && size > CAPS.previewText) return { tooBig: size }
    return { body, size }
  }
  const r = await oc(t.dir, t.conn)
    .file.read({ query: { path: rel } })
    .catch(() => null)
  if (!r?.data) throw new FsError("Couldn't read this file")
  const body = bodyOf(r.data)
  const size = body.kind === "text" ? new Blob([body.text]).size : body.bytes.length
  if (size > (body.kind === "text" ? CAPS.previewText : CAPS.previewBinary)) return { tooBig: size }
  if (body.kind === "binary" && !body.mime) body.mime = mimeOf(name)
  return { body, size }
}

/** Saves one file to the computer, byte-exact where possible. */
export async function downloadFile(t: Target, rel: string, name: string): Promise<void> {
  if (!cloud(t)) {
    const r = await fetch(localUrl(t, { op: "raw", path: rel }))
    if (!r.ok) throw await failure(r)
    return saveBlob(name, await r.blob())
  }
  const r = await fetch(cloudUrl(t, { op: "raw", path: rel }))
  if (r.ok) return saveBlob(name, await r.blob())
  if (r.status !== 413) throw await failure(r)
  // Over the server route's limit: straight from the engine (binary is exact; text comes back trimmed).
  const d = await oc(t.dir, t.conn)
    .file.read({ query: { path: rel } })
    .catch(() => null)
  if (!d?.data) throw new FsError("Couldn't read this file")
  const body = bodyOf(d.data)
  saveBlob(name, body.kind === "text" ? new Blob([body.text], { type: "text/plain;charset=utf-8" }) : new Blob([body.bytes]))
}

/** Downloads a folder (or the whole workspace, rel "") as a .zip. Resolves to how many files went in. */
export async function downloadZip(t: Target, rel: string, showHidden: boolean): Promise<number> {
  const base = rel ? rel.split("/").pop()! : t.dir.split(/[\\/]/).filter(Boolean).pop() || "workspace"
  const q = { op: "zip", path: rel, ...(showHidden ? { hidden: "1" } : {}) }
  if (!cloud(t)) {
    const r = await fetch(localUrl(t, q))
    if (!r.ok) throw await failure(r)
    const count = Number(r.headers.get("x-file-count") ?? 0)
    saveBlob(`${base}.zip`, await r.blob())
    return count
  }
  const r = await fetch(cloudUrl(t, q), { method: "POST" })
  if (!r.ok) throw await failure(r)
  const z = (await r.json()) as { file: string; name: string; count: number }
  try {
    const d = await oc(t.dir, t.conn)
      .file.read({ query: { path: z.file } })
      .catch(() => null)
    if (!d?.data || d.data.encoding !== "base64") throw new FsError("Couldn't fetch the zip")
    const body = bodyOf(d.data)
    if (body.kind !== "binary") throw new FsError("Couldn't fetch the zip")
    saveBlob(`${base}.zip`, new Blob([body.bytes], { type: "application/zip" }))
  } finally {
    void fetch(cloudUrl(t, { op: "zip", file: z.file }), { method: "DELETE" }).catch(() => {})
  }
  return z.count
}

export type Upload = { file: File; rel: string }

/** Uploads files into the workspace in chunks. An existing name gets " (2)". Resolves to the paths written. */
export async function upload(t: Target, items: Upload[], onProgress?: (done: number, total: number) => void): Promise<string[]> {
  const cap = cloud(t) ? CAPS.uploadCloud : CAPS.uploadLocal
  const chunk = cloud(t) ? CAPS.chunkCloud : CAPS.chunkLocal
  const tooBig = items.find((i) => i.file.size > cap)
  if (tooBig) throw new FsError(`${tooBig.file.name} is over ${fmtBytes(cap)}, the limit here`)
  const all = items.reduce((n, i) => n + i.file.size, 0)
  let sent = 0
  const out: string[] = []
  for (const it of items) {
    let path = it.rel
    let offset = 0
    do {
      const part = new Uint8Array(await it.file.slice(offset, offset + chunk).arrayBuffer())
      const q = { op: "upload", path, offset: String(offset), total: String(it.file.size) }
      const r = await fetch(cloud(t) ? cloudUrl(t, q) : localUrl(t, q), { method: "POST", headers: { "content-type": "application/octet-stream", "x-chunk-size": String(part.length) }, body: part })
      if (!r.ok) throw await failure(r)
      path = ((await r.json()) as { path: string }).path
      offset += part.length
      sent += part.length
      onProgress?.(sent, all)
    } while (offset < it.file.size)
    out.push(path)
  }
  return out
}

type FsEntry = { isFile: boolean; isDirectory: boolean; name: string; file?(ok: (f: File) => void, err: (e: unknown) => void): void; createReader?(): { readEntries(ok: (e: FsEntry[]) => void, err: (e: unknown) => void): void } }

/** Files from a drop, folders included (relative paths kept), placed under `dir`. */
export async function filesFromDrop(dt: DataTransfer, dir: string): Promise<Upload[]> {
  const out: Upload[] = []
  const roots = [...dt.items].map((i) => (i.kind === "file" ? (i as DataTransferItem & { webkitGetAsEntry?(): FsEntry | null }).webkitGetAsEntry?.() : null))
  if (roots.every((r) => !r)) return [...dt.files].map((file) => ({ file, rel: joinRel(dir, file.name) }))
  async function visit(e: FsEntry, at: string) {
    const name = cleanName(e.name)
    if (!name || out.length > 2000) return
    if (e.isFile && e.file) {
      const file = await new Promise<File>((ok, err) => e.file!(ok, err))
      out.push({ file, rel: joinRel(at, name) })
    } else if (e.isDirectory && e.createReader) {
      if (isHidden(name, false)) return
      const reader = e.createReader()
      for (;;) {
        const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err))
        if (!batch.length) break
        for (const c of batch) await visit(c, joinRel(at, name))
      }
    }
  }
  for (const r of roots) if (r) await visit(r, dir)
  return out
}
