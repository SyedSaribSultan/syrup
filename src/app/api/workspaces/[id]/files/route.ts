import crypto from "node:crypto"
import type { Sandbox } from "@vercel/sandbox"
import { CAPS, cleanName, cleanRel, numbered, parentRel, ZIP_DIR } from "@/lib/fs-rules"
import { handler, requireUser } from "@/server/cloud/session"
import { workspaceFiles } from "@/server/engine/sandbox"
import { zipScriptArgs } from "@/server/engine/sandbox-zip"
import { fileHeaders } from "@/server/workspace-files"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Files panel, cloud mode. Signed-in user, workspace they own (RLS through
 * getWorkspace), running sandbox; paths are workspace-relative and checked
 * with realpath inside the sandbox. Browsing and previews read through the
 * sandbox's engine directly; these are the parts it can't do.
 *   GET    ?op=raw&path=<rel>                         exact bytes, up to 4 MB (Vercel's response limit)
 *   POST   ?op=zip&path=<rel>[&hidden=1]              builds a zip in the workspace, returns where
 *   DELETE ?op=zip&file=<name>                        removes it once downloaded
 *   POST   ?op=upload&path=<rel>&offset=<n>&total=<n> one chunk (raw body, up to 4 MB)
 */

type Ctx = { params: Promise<{ id: string }> }

const bad = (error: string, status = 400) => Response.json({ error }, { status })

async function resolve(sb: Sandbox, root: string, raw: string | null): Promise<{ rel: string; abs: string }> {
  const rel = cleanRel(raw ?? "")
  if (rel === null) throw bad("bad path")
  let real: string
  try {
    real = await sb.fs.realpath(rel ? `${root}/${rel}` : root)
  } catch {
    throw bad("not found", 404)
  }
  if (real !== root && !real.startsWith(`${root}/`)) throw bad("path is outside the workspace", 403)
  return { rel, abs: real }
}

export const GET = handler(async (req: Request, ctx: Ctx) => {
  const me = await requireUser()
  const { id } = await ctx.params
  const q = new URL(req.url).searchParams
  if (q.get("op") !== "raw") return bad("op must be raw")
  const { sb, root } = await workspaceFiles(me.id, id)
  const { abs } = await resolve(sb, root, q.get("path"))
  const st = await sb.fs.stat(abs)
  if (!st.isFile()) return bad("not a file")
  if (st.size > CAPS.rawCloud) return bad("too big for this route", 413)
  const buf = await sb.readFileToBuffer({ path: abs })
  if (!buf) return bad("not found", 404)
  return new Response(new Uint8Array(buf), { headers: fileHeaders(buf.length) })
})

export const POST = handler(async (req: Request, ctx: Ctx) => {
  const me = await requireUser()
  const { id } = await ctx.params
  const q = new URL(req.url).searchParams
  const op = q.get("op")
  if (op !== "zip" && op !== "upload") return bad("op must be zip or upload")
  const { sb, root } = await workspaceFiles(me.id, id)

  if (op === "zip") {
    const { rel, abs } = await resolve(sb, root, q.get("path"))
    const file = `${crypto.randomBytes(9).toString("hex")}.zip`
    const r = await sb.runCommand({ cmd: "node", args: zipScriptArgs(root, abs.slice(root.length + 1), `${root}/${ZIP_DIR}/${file}`, q.get("hidden") === "1"), cwd: root })
    const out = (await r.stdout()).trim()
    let j: { count?: number; bytes?: number; error?: string }
    try {
      j = JSON.parse(out)
    } catch {
      return bad(`zip failed (exit ${r.exitCode}): ${(await r.stderr()).slice(-300)}`, 500)
    }
    if (j.error) return bad(j.error, 413)
    const base = rel ? rel.split("/").pop()! : "workspace"
    return Response.json({ file: `${ZIP_DIR}/${file}`, name: `${base}.zip`, count: j.count, bytes: j.bytes })
  }

  const rel = cleanRel(q.get("path") ?? "")
  const name = cleanName(rel?.split("/").pop() ?? "")
  const offset = Number(q.get("offset"))
  const total = Number(q.get("total"))
  if (!rel || !name) return bad("bad file name")
  const body = new Uint8Array(await req.arrayBuffer())
  if (Number(req.headers.get("x-chunk-size")) !== body.length) return bad("chunk arrived incomplete")
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || offset < 0 || offset + body.length > total) return bad("bad chunk")
  if (total > CAPS.uploadCloud) return bad("file is over 50 MB", 413)
  if (body.length > CAPS.chunkCloud) return bad("chunk too big", 413)

  const dirRel = parentRel(rel)
  if (dirRel.split("/").some((s) => s && !cleanName(s))) return bad("bad folder name")
  if (dirRel) await sb.fs.mkdir(`${root}/${dirRel}`, { recursive: true })
  const { abs: dir } = await resolve(sb, root, dirRel)
  if (!(await sb.fs.stat(dir)).isDirectory()) return bad("not a folder", 409)

  let final = name
  if (offset === 0) {
    for (let n = 2; await sb.fs.exists(`${dir}/${final}`); n++) {
      if (n > 200) return bad("too many files with that name", 409)
      final = numbered(name, n)
    }
  }
  const temp = `${dir}/.${final}.syrup-upload`
  if (offset === 0) await sb.writeFiles([{ path: temp, content: body }])
  else {
    const st = await sb.fs.stat(temp).catch(() => null)
    if (!st?.isFile() || st.size !== offset) return bad("upload out of order, start again", 409)
    await sb.fs.appendFile(temp, body)
  }
  const done = offset + body.length === total
  if (done) {
    let dest = final
    for (let n = 2; await sb.fs.exists(`${dir}/${dest}`); n++) dest = numbered(final, n)
    await sb.fs.rename(temp, `${dir}/${dest}`)
    final = dest
  }
  return Response.json({ path: dirRel ? `${dirRel}/${final}` : final, done })
})

export const DELETE = handler(async (req: Request, ctx: Ctx) => {
  const me = await requireUser()
  const { id } = await ctx.params
  const q = new URL(req.url).searchParams
  const file = q.get("file") ?? ""
  if (q.get("op") !== "zip" || !/^\.syrup-downloads\/[0-9a-f]{18}\.zip$/.test(file)) return bad("bad file")
  const { sb, root } = await workspaceFiles(me.id, id)
  await sb.fs.rm(`${root}/${file}`, { force: true })
  return Response.json({ ok: true })
})
