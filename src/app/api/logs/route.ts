import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { formatLogs, queryLogs, slogMany, type Level, type Source } from "@/server/log"

export const dynamic = "force-dynamic"

const LEVELS: Level[] = ["debug", "info", "warn", "error"]
const SOURCES: Source[] = ["boot", "engine", "router", "mcp", "memory", "skills", "providers", "workspace", "ledger", "api", "ui"]

/** Tail of OpenCode's own log file, filtered to lines at or after `since`. */
function engineLogTail(since: number, maxLines = 400): string[] {
  const file = path.join(os.homedir(), ".local", "share", "opencode", "log", "opencode.log")
  try {
    const stat = fs.statSync(file)
    const size = Math.min(stat.size, 2 * 1024 * 1024)
    const fd = fs.openSync(file, "r")
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, stat.size - size)
    fs.closeSync(fd)
    const lines = buf.toString("utf8").split(/\r?\n/)
    const out: string[] = []
    for (const line of lines) {
      const m = line.match(/^timestamp=(\S+)/)
      if (!m) continue
      const t = Date.parse(m[1])
      if (Number.isFinite(t) && t >= since) out.push(line)
    }
    return out.slice(-maxLines)
  } catch {
    return []
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url)
  const since = Number(u.searchParams.get("since")) || undefined
  const until = Number(u.searchParams.get("until")) || undefined
  const levels = (u.searchParams.get("levels") ?? "").split(",").filter((l): l is Level => LEVELS.includes(l as Level))
  const sources = (u.searchParams.get("sources") ?? "").split(",").filter((s): s is Source => SOURCES.includes(s as Source))
  const sessionId = u.searchParams.get("session") || undefined
  const q = u.searchParams.get("q") || undefined
  const limit = Number(u.searchParams.get("limit")) || 2000
  const format = u.searchParams.get("format")

  const rows = await queryLogs({ since, until, levels, sources, sessionId, q, limit })
  const engineTail = u.searchParams.get("engine") === "1" ? engineLogTail(since ?? Date.now() - 3_600_000) : undefined

  if (format === "text") {
    const header = [
      `# syrup logs`,
      `# exported ${new Date().toISOString()}`,
      `# range ${since ? new Date(since).toISOString() : "beginning"} → ${until ? new Date(until).toISOString() : "now"}`,
      `# filters levels=${levels.join(",") || "all"} sources=${sources.join(",") || "all"} session=${sessionId ?? "-"} q=${q ?? "-"}`,
      `# rows ${rows.length}`,
      ``,
    ].join("\n")
    const body = formatLogs(rows)
    const tail = engineTail && engineTail.length ? `\n\n# ---- OpenCode engine log (${engineTail.length} lines) ----\n${engineTail.join("\n")}` : ""
    return new Response(header + body + tail, { headers: { "content-type": "text/plain; charset=utf-8" } })
  }
  return Response.json({ rows, engineTail })
}

const Row = z.object({
  ts: z.number().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  event: z.string().min(1).max(120),
  data: z.unknown().optional(),
  sessionId: z.string().nullable().optional(),
  directory: z.string().nullable().optional(),
})

/** Browser-side log rows, batched. */
export async function POST(req: Request) {
  const parsed = z.array(Row).max(500).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "bad batch" }, { status: 400 })
  slogMany(parsed.data.map((r) => ({ ...r, source: "ui" as const })))
  return Response.json({ ok: true })
}
