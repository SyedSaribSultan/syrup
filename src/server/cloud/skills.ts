import { and, asc, eq, inArray } from "drizzle-orm"
import { ulid } from "ulid"
import { pgSchema, withUser } from "../db/pg"
import { slog } from "../log"
import type { SkillInfo } from "../skills"
import { extractSkills, parseGithubSource, pastedSkill, promptTokens, safeRelPath, SKILL_LIMITS, SKILL_NAME_RE, untar, validSkillName, type ExtractedSkill } from "../skills-core"
import { audit } from "./audit"
import { githubToken } from "./github"

/**
 * Skills (cloud). Each user's SKILL.md folders live in user_skills and are
 * written into every workspace sandbox when its engine starts, and pushed to
 * running sandboxes after a change (engine/sandbox.ts syncSkills). Skill
 * content is stored and copied, never run here.
 */

/** Where OpenCode finds the skills inside a sandbox (HOME=/vercel). */
export const SANDBOX_SKILLS_DIR = "/vercel/.config/opencode/skills"

const MAX_TARBALL_BYTES = 30 * 1024 * 1024

export async function listCloudSkills(userId: string): Promise<SkillInfo[]> {
  const rows = await withUser(userId, (tx) =>
    tx
      .select({ name: pgSchema.userSkills.name, description: pgSchema.userSkills.description, content: pgSchema.userSkills.content, enabled: pgSchema.userSkills.enabled })
      .from(pgSchema.userSkills)
      .where(eq(pgSchema.userSkills.userId, userId))
      .orderBy(asc(pgSchema.userSkills.name)),
  )
  return rows.map((r) => {
    const location = `${SANDBOX_SKILLS_DIR}/${r.name}/SKILL.md`
    // One folder per user in the sandbox and names are unique per user, so there is nothing to duplicate.
    return { name: r.name, description: r.description, location, managed: true, source: "syrup", enabled: r.enabled, tokens: promptTokens(r.name, r.description, location), content: r.content, duplicates: [] }
  })
}

/** Stores skills, replacing same-named ones. A fresh install starts on, like local mode. */
async function saveSkills(userId: string, source: string, skills: ExtractedSkill[]): Promise<string[]> {
  const names = skills.map((s) => s.name)
  await withUser(userId, async (tx) => {
    const existing = await tx.select({ name: pgSchema.userSkills.name, bytes: pgSchema.userSkills.bytes }).from(pgSchema.userSkills).where(eq(pgSchema.userSkills.userId, userId))
    const kept = existing.filter((r) => !names.includes(r.name))
    if (kept.length + skills.length > SKILL_LIMITS.maxSkills) throw new Error(`You can keep up to ${SKILL_LIMITS.maxSkills} skills. Remove some first.`)
    const total = kept.reduce((n, r) => n + r.bytes, 0) + skills.reduce((n, s) => n + s.bytes, 0)
    if (total > SKILL_LIMITS.maxUserBytes) throw new Error(`Skills are limited to ${SKILL_LIMITS.maxUserBytes / 1024 / 1024} MB in total. Remove some first.`)
    const now = new Date()
    for (const s of skills) {
      const values = { source, description: s.description, content: s.content, files: s.files, bytes: s.bytes, enabled: true, updatedAt: now }
      await tx
        .insert(pgSchema.userSkills)
        .values({ id: ulid(), userId, name: s.name, ...values })
        .onConflictDoUpdate({ target: [pgSchema.userSkills.userId, pgSchema.userSkills.name], set: values })
    }
    await audit(tx, { userId, actor: "user", action: "skill.install", data: { source, names } })
  })
  return names
}

export async function createCloudSkill(userId: string, content: string, nameOverride?: string): Promise<string> {
  const skill = pastedSkill(content, nameOverride)
  await saveSkills(userId, "pasted", [skill])
  slog("skills", "created", { name: skill.name, chars: content.length, userId })
  return skill.name
}

/** Reads a response body, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new Error(`That repository is larger than ${max / 1024 / 1024} MB`)
  const reader = res.body!.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel()
      throw new Error(`That repository is larger than ${max / 1024 / 1024} MB`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * GitHub tarball of the default branch (or the `/tree/<ref>` given). With the
 * user's GitHub token it goes through the API, so private repos work;
 * otherwise codeload serves public repos without API rate limits.
 */
async function fetchTarball(userId: string, owner: string, repo: string, ref: string | null): Promise<Buffer> {
  const token = await githubToken(userId)
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const url = token ? `https://api.github.com/repos/${path}/tarball${ref ? `/${encodeURIComponent(ref)}` : ""}` : `https://codeload.github.com/${path}/tar.gz/${ref ? encodeURIComponent(ref) : "HEAD"}`
  const headers: Record<string, string> = { "user-agent": "syrup", ...(token ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } : {}) }
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) })
  if (res.status === 404) throw new Error(token ? "Repository not found, or your GitHub token cannot access it." : "Repository not found. If it is private, add a GitHub token under Account & privacy → Connections.")
  if (res.status === 401) throw new Error("Your GitHub token was rejected. Replace it under Account & privacy → Connections.")
  if (!res.ok || !res.body) throw new Error(`GitHub returned ${res.status} for that repository.`)
  return readCapped(res, MAX_TARBALL_BYTES)
}

/** Installs every SKILL.md folder under the given GitHub path (skill packs work). Oversized or badly named skills are skipped and reported. */
export async function installCloudFromGit(userId: string, source: string): Promise<{ installed: string[]; skipped: string[] }> {
  const src = parseGithubSource(source)
  try {
    const tarball = await fetchTarball(userId, src.owner, src.repo, src.ref)
    const { skills, skipped } = extractSkills(untar(tarball), src.sub)
    const installed = await saveSkills(userId, `https://github.com/${src.owner}/${src.repo}${src.sub ? `/${src.sub}` : ""}`, skills)
    slog("skills", "installed", { source, installed, skipped, userId })
    return { installed, skipped }
  } catch (err) {
    slog("skills", "install.failed", { source, err, userId }, { level: "warn" })
    throw err
  }
}

/** Applies on/off switches; names the user has no skill for are ignored. */
export async function setCloudSkillsEnabled(userId: string, changes: Record<string, boolean>): Promise<void> {
  const on = Object.keys(changes).filter((n) => changes[n])
  const off = Object.keys(changes).filter((n) => !changes[n])
  await withUser(userId, async (tx) => {
    const now = new Date()
    if (on.length) await tx.update(pgSchema.userSkills).set({ enabled: true, updatedAt: now }).where(and(eq(pgSchema.userSkills.userId, userId), inArray(pgSchema.userSkills.name, on)))
    if (off.length) await tx.update(pgSchema.userSkills).set({ enabled: false, updatedAt: now }).where(and(eq(pgSchema.userSkills.userId, userId), inArray(pgSchema.userSkills.name, off)))
  })
  slog("skills", "toggled", { changes, userId })
}

export async function removeCloudSkill(userId: string, name: string): Promise<void> {
  validSkillName(name)
  const removed = await withUser(userId, async (tx) => {
    const rows = await tx.delete(pgSchema.userSkills).where(and(eq(pgSchema.userSkills.userId, userId), eq(pgSchema.userSkills.name, name))).returning({ id: pgSchema.userSkills.id })
    if (rows.length) await audit(tx, { userId, actor: "user", action: "skill.remove", target: name })
    return rows.length
  })
  if (!removed) throw new Error("Only skills installed by syrup can be removed here")
  slog("skills", "removed", { name, userId })
}

export type SkillBundle = {
  /** Files of the enabled skills, paths relative to the skills folder (`<name>/<path>`). */
  files: { path: string; content: Buffer }[]
  enabled: string[]
}

/** What a sandbox needs: enabled skills' files, and their names for `permission.skill`. */
export async function skillBundle(userId: string): Promise<SkillBundle> {
  const rows = await withUser(userId, (tx) =>
    tx
      .select({ name: pgSchema.userSkills.name, files: pgSchema.userSkills.files })
      .from(pgSchema.userSkills)
      .where(and(eq(pgSchema.userSkills.userId, userId), eq(pgSchema.userSkills.enabled, true))),
  )
  const files: SkillBundle["files"] = []
  const enabled: string[] = []
  for (const r of rows) {
    if (!SKILL_NAME_RE.test(r.name)) continue
    enabled.push(r.name)
    for (const f of r.files) {
      const rel = safeRelPath(f.path)
      if (rel) files.push({ path: `${r.name}/${rel}`, content: Buffer.from(f.data, "base64") })
    }
  }
  return { files, enabled }
}
