import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { eq } from "drizzle-orm"
import { db, dbReady, schema } from "./db"
import { engine, engineAuthHeader } from "./engine/opencode"
import { env } from "./env"
import { slog } from "./log"
import { forgetSaribScans, knownDirectories } from "./sarib"
import { parseFrontmatter, promptTokens, skillConfigJson, validSkillName as validName } from "./skills-core"

const run = promisify(execFile)

/**
 * Skills are folders with a SKILL.md, discovered by OpenCode from a few
 * well-known locations. syrup installs into the global OpenCode skills dir
 * so they work in every project (and in the OpenCode TUI too).
 */

export type SkillSource = "syrup" | "claude" | "agents" | "project" | "builtin"

export type SkillInfo = {
  name: string
  description: string
  location: string
  /** True when it lives in the directory syrup manages and can be removed from the UI. */
  managed: boolean
  source: SkillSource
  /** Only enabled skills are listed in the agent's prompt. */
  enabled: boolean
  /** Rough prompt cost of listing this skill, per request. */
  tokens: number
  content: string
}

export function skillsDir() {
  return path.join(os.homedir(), ".config", "opencode", "skills")
}

function under(file: string, root: string) {
  return path.resolve(file).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)
}

function sourceOf(location: string, managed: boolean): SkillSource {
  if (managed) return "syrup"
  if (!path.isAbsolute(location)) return "builtin"
  if (under(location, path.join(os.homedir(), ".claude"))) return "claude"
  if (under(location, path.join(os.homedir(), ".agents"))) return "agents"
  return "project"
}

export async function listSkills(): Promise<SkillInfo[]> {
  const { url } = await engine()
  const [res, toggles] = await Promise.all([fetch(`${url}/skill`, { headers: { authorization: engineAuthHeader() } }), readToggles()])
  if (!res.ok) throw new Error(`engine: could not list skills (${res.status})`)
  const rows = (await res.json()) as { name: string; description?: string; location: string; content: string }[]
  return rows
    .map((r) => {
      const managed = under(r.location, skillsDir())
      const description = r.description ?? parseFrontmatter(r.content).description ?? ""
      return {
        name: r.name,
        description,
        location: r.location,
        managed,
        source: sourceOf(r.location, managed),
        enabled: toggles[r.name] ?? managed,
        tokens: promptTokens(r.name, description, r.location),
        content: r.content,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Which skills reach the agent's prompt, stored as explicit choices by name.
 * A skill with no choice is on when syrup installed it and off otherwise, so
 * skills that show up in ~/.claude or a project stay out until turned on.
 */
const TOGGLES_KEY = "skills.enabled"

async function readToggles(): Promise<Record<string, boolean>> {
  await dbReady()
  const [row] = await db().select().from(schema.settings).where(eq(schema.settings.key, TOGGLES_KEY))
  if (!row) return {}
  try {
    return JSON.parse(row.value) as Record<string, boolean>
  } catch {
    return {}
  }
}

async function writeToggles(toggles: Record<string, boolean>) {
  await dbReady()
  const value = JSON.stringify(toggles)
  await db().insert(schema.settings).values({ key: TOGGLES_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } })
}

/** Drops stored choices so these names fall back to their default. */
async function clearToggles(names: string[]) {
  const toggles = await readToggles()
  if (!names.some((n) => n in toggles)) return
  for (const n of names) delete toggles[n]
  await writeToggles(toggles)
}

/** Skills in the syrup-managed dir, read from disk so this works before the engine is up. */
function managedNames(): string[] {
  const names: string[] = []
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue
      const sub = path.join(dir, e.name)
      const md = path.join(sub, "SKILL.md")
      if (fs.existsSync(md)) names.push(parseFrontmatter(fs.readFileSync(md, "utf8")).name?.trim() || e.name)
      else if (depth < 2) walk(sub, depth + 1)
    }
  }
  walk(skillsDir(), 0)
  return names
}

/** OpenCode config holding only skill permissions. The engine gets it as OPENCODE_CONFIG and re-reads it whenever an instance boots. */
export function skillConfigPath() {
  return path.join(env.configDir, "engine-skills.json")
}

/** Writes `permission.skill` (skills-core.ts skillPermission) so OpenCode lists only enabled skills. */
export async function writeSkillConfig(): Promise<string> {
  const toggles = await readToggles()
  const on = new Set(managedNames())
  for (const [name, enabled] of Object.entries(toggles)) {
    if (enabled) on.add(name)
    else on.delete(name)
  }
  const file = skillConfigPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, skillConfigJson(on), "utf8")
  return file
}

export async function setSkillsEnabled(changes: Record<string, boolean>): Promise<void> {
  const toggles = { ...(await readToggles()), ...changes }
  await writeToggles(toggles)
  await writeSkillConfig()
  slog("skills", "toggled", { changes })
  scheduleReload(300)
}

const g = globalThis as unknown as { __syrupSkillReload?: ReturnType<typeof setTimeout> }

/** Batches quick toggles into one reload. */
function scheduleReload(ms: number) {
  clearTimeout(g.__syrupSkillReload)
  g.__syrupSkillReload = setTimeout(() => void reloadWhenIdle().catch((err) => slog("engine", "reload.failed", err, { level: "warn" })), ms)
}

/**
 * Disposing an instance stops the turns running in it, so this waits until
 * every session is idle, then drops all instances. Each boots again on its
 * next request and reads the new skill permissions.
 */
async function reloadWhenIdle() {
  const { url } = await engine()
  const headers = { authorization: engineAuthHeader() }
  for (const dir of new Set([env.workspace, ...knownDirectories()])) {
    const res = await fetch(`${url}/session/status?directory=${encodeURIComponent(dir)}`, { headers })
    if (!res.ok) continue
    const status = (await res.json()) as Record<string, { type: string }>
    if (Object.values(status).some((s) => s.type !== "idle")) {
      slog("engine", "reload.deferred", { reason: "skills toggled", busy: dir })
      return scheduleReload(5_000)
    }
  }
  const res = await fetch(`${url}/global/dispose`, { method: "POST", headers })
  if (!res.ok) throw new Error(`engine: could not reload (${res.status})`)
  forgetSaribScans()
  slog("engine", "instance.reloaded", { reason: "skills toggled", all: true })
}

/** A fresh install starts on and a removed skill forgets its choice, so both reset the stored choice. */
async function reload(names: string[]) {
  await clearToggles(names)
  await writeSkillConfig()
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
  await reload([name])
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
    await reload(installed)
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
  await reload([name])
}
