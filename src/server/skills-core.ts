import { gunzipSync } from "node:zlib"

/**
 * Pure skill helpers shared by local mode (skills.ts) and the hosted version
 * (cloud/skills.ts): names, frontmatter, the OpenCode permission map, and
 * reading SKILL.md folders out of a GitHub tarball. Nothing here executes
 * skill content.
 */

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function validSkillName(name: string): string {
  if (!SKILL_NAME_RE.test(name)) throw new Error("Skill name must be lowercase letters, digits and hyphens (1–64 chars)")
  return name
}

/** Minimal YAML frontmatter reader: only `name` and `description` matter. */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "")
  }
  return { name: out.name, description: out.description }
}

/** Each listed skill is its name, description and file URL wrapped in a few tags. */
export function promptTokens(name: string, description: string, location: string) {
  return Math.round((name.length + description.length + location.length) / 3.6) + 30
}

/**
 * `permission.skill` for OpenCode: it hides a skill whose permission
 * evaluates to deny and the last matching rule wins, so the catch-all deny
 * goes first. With nothing allowed, the skill tool is dropped as well.
 */
export function skillPermission(enabled: Iterable<string>): Record<string, "allow" | "deny"> {
  const skill: Record<string, "allow" | "deny"> = { "*": "deny" }
  for (const name of [...new Set(enabled)].sort()) skill[name] = "allow"
  return skill
}

export function skillConfigJson(enabled: Iterable<string>): string {
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { skill: skillPermission(enabled) } }, null, 2)
}

export type GithubSource = { owner: string; repo: string; ref: string | null; sub: string }

/** `owner/repo`, a repo URL, or either with `/path/inside` (or `/tree/<ref>/path`) appended. */
export function parseGithubSource(source: string): GithubSource {
  const m = source.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.-]+))?(?:\/(.*?))?\/?$/)
  if (!m || m[1] === "." || m[1] === ".." || m[2] === "." || m[2] === "..") throw new Error("Give a GitHub `owner/repo`, a repo URL, or a URL to a folder inside a repo")
  const sub = (m[4] ?? "").split("/").filter(Boolean)
  if (sub.some((s) => s === "." || s === "..")) throw new Error("That path is not allowed")
  return { owner: m[1], repo: m[2], ref: m[3] ?? null, sub: sub.join("/") }
}

export type TarFile = { path: string; data: Buffer }

function cstr(buf: Buffer, start: number, len: number) {
  const s = buf.subarray(start, start + len)
  const nul = s.indexOf(0)
  return (nul === -1 ? s : s.subarray(0, nul)).toString("utf8")
}

function octal(buf: Buffer, start: number, len: number) {
  const s = cstr(buf, start, len).trim()
  return s ? parseInt(s, 8) : 0
}

function paxPath(body: Buffer): string | null {
  let i = 0
  let path: string | null = null
  while (i < body.length) {
    const sp = body.indexOf(0x20, i)
    if (sp === -1) break
    const len = parseInt(body.subarray(i, sp).toString("utf8"), 10)
    if (!len) break
    const rec = body.subarray(sp + 1, i + len - 1).toString("utf8")
    const eq = rec.indexOf("=")
    if (rec.slice(0, eq) === "path") path = rec.slice(eq + 1)
    i += len
  }
  return path
}

/**
 * Regular files from a (gzipped) ustar/pax tarball, as GitHub serves them.
 * Links, devices and directories are skipped. `maxBytes` caps the unpacked size.
 */
export function untar(archive: Buffer, maxBytes = 200 * 1024 * 1024): TarFile[] {
  const buf = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive, { maxOutputLength: maxBytes }) : archive
  const files: TarFile[] = []
  let off = 0
  let longName: string | null = null
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const size = octal(h, 124, 12)
    const type = String.fromCharCode(h[156] || 0x30)
    const body = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === "x") {
      longName = paxPath(body) ?? longName
      continue
    }
    if (type === "L") {
      longName = cstr(body, 0, body.length)
      continue
    }
    if (type === "g") continue
    const prefix = cstr(h, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100))
    longName = null
    if (type === "0" || type === "\0" || type === "7") files.push({ path: name, data: Buffer.from(body) })
  }
  return files
}

export type SkillFile = { path: string; data: string }

export type ExtractedSkill = { name: string; description: string; content: string; files: SkillFile[]; bytes: number }

export const SKILL_LIMITS = { maxFiles: 400, maxSkillBytes: 8 * 1024 * 1024, maxUserBytes: 24 * 1024 * 1024, maxSkills: 100, maxDepth: 3 }

/** A relative path inside a skill folder, or null when it could escape it or is not worth copying. */
export function safeRelPath(p: string): string | null {
  if (!p || p.includes("\\") || p.includes("\0") || p.startsWith("/")) return null
  const parts = p.split("/").filter(Boolean)
  if (parts.length === 0 || parts.length > 12) return null
  for (const s of parts) {
    if (s === "." || s === ".." || s === ".git" || s === "node_modules" || s.length > 255) return null
  }
  return parts.join("/")
}

/**
 * Finds every folder with a SKILL.md under `sub` (the whole repo when empty),
 * up to three levels deep, so skill packs work. GitHub tarballs wrap
 * everything in one `<owner>-<repo>-<sha>/` folder, which is stripped first.
 */
export function extractSkills(files: TarFile[], sub: string): { skills: ExtractedSkill[]; skipped: string[] } {
  const rooted = files
    .map((f) => ({ path: f.path.split("/").slice(1).join("/"), data: f.data }))
    .filter((f) => f.path && (!sub || f.path === sub || f.path.startsWith(`${sub}/`)))
    .map((f) => ({ path: sub ? f.path.slice(sub.length + 1) : f.path, data: f.data }))
  if (rooted.length === 0) throw new Error(sub ? `Path not found in repo: ${sub}` : "The repository is empty")

  const dirs = new Set<string>()
  for (const f of rooted) {
    const parts = f.path.split("/")
    if (parts.pop() !== "SKILL.md" || parts.length > SKILL_LIMITS.maxDepth) continue
    if (parts.some((s) => s.startsWith(".") || s === "node_modules")) continue
    dirs.add(parts.join("/"))
  }
  const roots = [...dirs].filter((d) => ![...dirs].some((o) => o !== d && (o === "" || d.startsWith(`${o}/`)))).sort()
  if (roots.length === 0) throw new Error("No SKILL.md found there")

  const skills = new Map<string, ExtractedSkill>()
  const skipped: string[] = []
  for (const dir of roots) {
    const inside = rooted.filter((f) => !dir || f.path.startsWith(`${dir}/`)).map((f) => ({ rel: dir ? f.path.slice(dir.length + 1) : f.path, data: f.data }))
    const md = inside.find((f) => f.rel === "SKILL.md")!
    const content = md.data.toString("utf8")
    const fm = parseFrontmatter(content)
    const name = (fm.name ?? dir.split("/").pop() ?? "").trim()
    if (!SKILL_NAME_RE.test(name)) {
      skipped.push(`${name || dir} (name must be lowercase letters, digits and hyphens)`)
      continue
    }
    const out: SkillFile[] = []
    let bytes = 0
    for (const f of inside) {
      const rel = safeRelPath(f.rel)
      if (!rel) continue
      bytes += f.data.length
      out.push({ path: rel, data: f.data.toString("base64") })
    }
    if (out.length > SKILL_LIMITS.maxFiles) skipped.push(`${name} (more than ${SKILL_LIMITS.maxFiles} files)`)
    else if (bytes > SKILL_LIMITS.maxSkillBytes) skipped.push(`${name} (larger than ${SKILL_LIMITS.maxSkillBytes / 1024 / 1024} MB)`)
    else skills.set(name, { name, description: fm.description ?? "", content, files: out, bytes })
  }
  if (skills.size === 0) throw new Error(`Nothing could be installed: ${skipped.join(", ")}`)
  return { skills: [...skills.values()], skipped }
}

/** A skill made from pasted SKILL.md text. */
export function pastedSkill(content: string, nameOverride?: string): ExtractedSkill {
  const fm = parseFrontmatter(content)
  const name = validSkillName((nameOverride ?? fm.name ?? "").trim())
  if (!fm.description && !content.includes("description:")) throw new Error("SKILL.md needs a `description` in its frontmatter")
  const data = Buffer.from(content, "utf8")
  if (data.length > SKILL_LIMITS.maxSkillBytes) throw new Error("SKILL.md is too large")
  return { name, description: fm.description ?? "", content, files: [{ path: "SKILL.md", data: data.toString("base64") }], bytes: data.length }
}
