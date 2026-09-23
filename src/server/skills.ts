import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { engine, engineAuthHeader } from "./engine/opencode"
import { slog } from "./log"

const run = promisify(execFile)

/**
 * Skills are folders with a SKILL.md, discovered by OpenCode from a few
 * well-known locations. syrup installs into the global OpenCode skills dir
 * so they work in every project (and in the OpenCode TUI too).
 */

export type SkillInfo = {
  name: string
  description: string
  location: string
  /** True when it lives in the directory syrup manages and can be removed from the UI. */
  managed: boolean
  content: string
}

export function skillsDir() {
  return path.join(os.homedir(), ".config", "opencode", "skills")
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

export async function listSkills(): Promise<SkillInfo[]> {
  const { url } = await engine()
  const res = await fetch(`${url}/skill`, { headers: { authorization: engineAuthHeader() } })
  if (!res.ok) throw new Error(`engine: could not list skills (${res.status})`)
  const rows = (await res.json()) as { name: string; description?: string; location: string; content: string }[]
  const managedRoot = path.resolve(skillsDir()).toLowerCase()
  return rows
    .map((r) => ({
      name: r.name,
      description: r.description ?? parseFrontmatter(r.content).description ?? "",
      location: r.location,
      managed: path.resolve(r.location).toLowerCase().startsWith(managedRoot),
      content: r.content,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function validName(name: string) {
  if (!NAME_RE.test(name)) throw new Error("Skill name must be lowercase letters, digits and hyphens (1–64 chars)")
  return name
}

async function reload() {
  const { client } = await engine()
  await client.instance.dispose()
  slog("engine", "instance.reloaded", { reason: "skills changed" })
}

/** Create a skill from SKILL.md text. */
export async function createSkill(content: string, nameOverride?: string): Promise<string> {
  const fm = parseFrontmatter(content)
  const name = validName((nameOverride ?? fm.name ?? "").trim())
  if (!fm.description && !content.includes("description:")) throw new Error("SKILL.md needs a `description` in its frontmatter")
  const dir = path.join(skillsDir(), name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8")
  slog("skills", "created", { name, dir, chars: content.length })
  await reload()
  return name
}

/**
 * Install from a git repository. Accepts a full URL, `owner/repo`, or either
 * with `/path/inside` appended. Installs every SKILL.md folder found under
 * the chosen path (so skill packs work), up to three levels deep.
 */
export async function installFromGit(source: string): Promise<string[]> {
  let repo = source.trim()
  let sub = ""
  const gh = repo.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/[\w.-]+)?(?:\/(.*))?$/)
  if (gh) {
    repo = `https://github.com/${gh[1]}/${gh[2]}.git`
    sub = gh[3] ?? ""
  }
  if (!/^(https?:\/\/|git@)/.test(repo)) throw new Error("Give a GitHub `owner/repo`, a repo URL, or a URL to a folder inside a repo")

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syrup-skill-"))
  try {
    await run("git", ["clone", "--depth", "1", "--quiet", repo, tmp], { timeout: 120_000 })
    const root = path.join(tmp, sub)
    if (!fs.existsSync(root)) throw new Error(`Path not found in repo: ${sub}`)
    const found: string[] = []
    const walk = (dir: string, depth: number) => {
      if (fs.existsSync(path.join(dir, "SKILL.md"))) {
        found.push(dir)
        return
      }
      if (depth >= 3) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(dir, e.name), depth + 1)
      }
    }
    walk(root, 0)
    if (found.length === 0) throw new Error("No SKILL.md found there")

    const installed: string[] = []
    for (const dir of found) {
      const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")
      const name = validName((parseFrontmatter(md).name ?? path.basename(dir)).trim())
      const dest = path.join(skillsDir(), name)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.cpSync(dir, dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) })
      installed.push(name)
    }
    slog("skills", "installed", { source, repo, sub, installed })
    await reload()
    return installed
  } catch (err) {
    slog("skills", "install.failed", { source, err }, { level: "warn" })
    throw err
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function removeSkill(name: string): Promise<void> {
  validName(name)
  const dir = path.join(skillsDir(), name)
  if (!fs.existsSync(dir)) throw new Error("Only skills installed by syrup can be removed here")
  fs.rmSync(dir, { recursive: true, force: true })
  slog("skills", "removed", { name, dir })
  await reload()
}
