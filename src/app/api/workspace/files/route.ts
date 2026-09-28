import { env } from "@/server/env"
import { FilesError, rawFile, statFile, uploadChunk, zipFolder } from "@/server/workspace-files"

export const dynamic = "force-dynamic"

/**
 * Files panel, local mode (src/server/workspace-files.ts). Loopback-only and
 * same-origin for POST through src/proxy.ts; refused in the hosted version.
 *   GET  ?op=stat|raw|zip&workspace=<abs>&path=<rel>[&hidden=1]
 *   POST ?op=upload&workspace=<abs>&path=<rel>&offset=<n>&total=<n>  (body: raw bytes of one chunk)
 */

function fail(err: unknown): Response {
  if (err instanceof FilesError) return Response.json({ error: err.message }, { status: err.status })
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === "ENOENT") return Response.json({ error: "not found" }, { status: 404 })
  if (code === "EACCES" || code === "EPERM") return Response.json({ error: "permission denied" }, { status: 403 })
  return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
}

export async function GET(req: Request) {
  if (env.isCloud) return Response.json({ error: "not available in the hosted version" }, { status: 404 })
  const q = new URL(req.url).searchParams
  const workspace = q.get("workspace") ?? ""
  try {
    switch (q.get("op")) {
      case "stat":
        return Response.json(statFile(workspace, q.get("path")))
      case "raw":
        return rawFile(workspace, q.get("path"))
      case "zip":
        return await zipFolder(workspace, q.get("path"), q.get("hidden") === "1")
      default:
        return Response.json({ error: "op must be stat, raw or zip" }, { status: 400 })
    }
  } catch (err) {
    return fail(err)
  }
}

export async function POST(req: Request) {
  if (env.isCloud) return Response.json({ error: "not available in the hosted version" }, { status: 404 })
  const q = new URL(req.url).searchParams
  if (q.get("op") !== "upload") return Response.json({ error: "op must be upload" }, { status: 400 })
  try {
    const body = new Uint8Array(await req.arrayBuffer())
    const declared = Number(req.headers.get("x-chunk-size"))
    // The request guard buffers bodies up to a limit; a short body means it was cut, not that the file is short.
    if (declared !== body.length) return Response.json({ error: "chunk arrived incomplete" }, { status: 400 })
    return Response.json(await uploadChunk(q.get("workspace") ?? "", q.get("path"), Number(q.get("offset")), Number(q.get("total")), body))
  } catch (err) {
    return fail(err)
  }
}
