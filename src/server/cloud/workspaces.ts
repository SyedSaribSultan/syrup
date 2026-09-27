import { and, desc, eq, isNull } from "drizzle-orm"
import { ulid } from "ulid"
import { LIMIT_MESSAGE, MAX_WORKSPACES, nextColor } from "@/lib/workspace-limits"
import { pgSchema, withUser } from "../db/pg"
import { audit } from "./audit"
import { githubToken, inspectGithubRepo } from "./github"

/**
 * Workspaces (cloud). A workspace is a repository (or an empty folder) the
 * agent works in; each one gets its own sandbox (src/server/engine/sandbox.ts).
 * Every function here runs inside withUser(), so RLS scopes every row.
 */

export type Workspace = typeof pgSchema.workspaces.$inferSelect
export type SandboxRow = typeof pgSchema.sandboxes.$inferSelect

const GIT_URL = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/i

export function normalizeRepoUrl(input: string): string {
  let url = input.trim()
  const short = url.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (short) url = `https://github.com/${short[1]}/${short[2]}`
  url = url.replace(/\/+$/, "")
  if (!GIT_URL.test(url)) throw new Error("Give a public https URL on GitHub, GitLab, Bitbucket or Codeberg (or owner/repo for GitHub)")
  return url.endsWith(".git") ? url : `${url}.git`
}

export function repoName(url: string): string {
  return url.replace(/\.git$/, "").split("/").pop() || "workspace"
}

/** Home first, then most recently opened. Creates the user's Home on first call. */
export async function listWorkspaces(userId: string): Promise<(Workspace & { sandbox: SandboxRow | null })[]> {
  const select = () =>
    withUser(userId, async (tx) => {
      const rows = await tx
        .select()
        .from(pgSchema.workspaces)
        .leftJoin(pgSchema.sandboxes, eq(pgSchema.sandboxes.workspaceId, pgSchema.workspaces.id))
        .where(and(eq(pgSchema.workspaces.userId, userId), isNull(pgSchema.workspaces.deletedAt)))
        .orderBy(desc(pgSchema.workspaces.isHome), desc(pgSchema.workspaces.lastOpenedAt), desc(pgSchema.workspaces.createdAt))
      return rows.map((r) => ({ ...r.workspaces, sandbox: r.sandboxes }))
    })
  const rows = await select()
  if (rows.some((w) => w.isHome)) return rows
  await ensureHome(userId)
  return select()
}

export const HOME_NAME = "Home"

/**
 * Creates the user's Home workspace if it does not exist yet. Safe to race:
 * the partial unique index workspaces_home_idx admits one live Home per user,
 * so a concurrent insert does nothing and the winner's row is returned.
 * Home takes color 0; a workspace already holding it moves to a free color.
 * It counts toward the cap but is created even when the cap is reached.
 */
export async function ensureHome(userId: string): Promise<Workspace> {
  return withUser(userId, async (tx) => {
    const [existing] = await tx.select().from(pgSchema.workspaces).where(and(eq(pgSchema.workspaces.userId, userId), eq(pgSchema.workspaces.isHome, true), isNull(pgSchema.workspaces.deletedAt)))
    if (existing) return existing
    const [ws] = await tx.insert(pgSchema.workspaces).values({ id: ulid(), userId, name: HOME_NAME, source: "empty", color: 0, isHome: true }).onConflictDoNothing().returning()
    if (!ws) {
      const [winner] = await tx.select().from(pgSchema.workspaces).where(and(eq(pgSchema.workspaces.userId, userId), eq(pgSchema.workspaces.isHome, true), isNull(pgSchema.workspaces.deletedAt)))
      return winner
    }
    await tx.insert(pgSchema.sandboxes).values({ id: ulid(), workspaceId: ws.id, userId, vercelName: `ws_${ws.id.toLowerCase()}` })
    const others = await tx.select({ id: pgSchema.workspaces.id, color: pgSchema.workspaces.color }).from(pgSchema.workspaces).where(and(eq(pgSchema.workspaces.userId, userId), isNull(pgSchema.workspaces.deletedAt), eq(pgSchema.workspaces.isHome, false)))
    const clash = others.find((w) => w.color === 0)
    const free = nextColor([0, ...others.map((w) => w.color)])
    if (clash && free !== 0 && !others.some((w) => w.color === free)) await tx.update(pgSchema.workspaces).set({ color: free }).where(eq(pgSchema.workspaces.id, clash.id))
    await audit(tx, { userId, actor: "system", action: "workspace.create", target: ws.id, data: { source: ws.source, home: true } })
    return ws
  })
}

export async function getWorkspace(userId: string, id: string): Promise<(Workspace & { sandbox: SandboxRow | null }) | null> {
  return withUser(userId, async (tx) => {
    const [r] = await tx
      .select()
      .from(pgSchema.workspaces)
      .leftJoin(pgSchema.sandboxes, eq(pgSchema.sandboxes.workspaceId, pgSchema.workspaces.id))
      .where(and(eq(pgSchema.workspaces.id, id), eq(pgSchema.workspaces.userId, userId), isNull(pgSchema.workspaces.deletedAt)))
    return r ? { ...r.workspaces, sandbox: r.sandboxes } : null
  })
}

export async function createWorkspace(userId: string, input: { name?: string; repoUrl?: string }): Promise<Workspace> {
  const repoUrl = input.repoUrl ? normalizeRepoUrl(input.repoUrl) : null
  const name = (input.name?.trim() || (repoUrl ? repoName(repoUrl) : "New workspace")).slice(0, 80)
  // GitHub repos are looked up first: clear errors for typos and private repos, and the default branch on record.
  let defaultBranch: string | null = null
  if (repoUrl?.includes("github.com")) {
    const info = await inspectGithubRepo(repoUrl, await githubToken(userId))
    defaultBranch = info?.defaultBranch ?? null
  }
  return withUser(userId, async (tx) => {
    const live = await tx.select({ color: pgSchema.workspaces.color }).from(pgSchema.workspaces).where(and(eq(pgSchema.workspaces.userId, userId), isNull(pgSchema.workspaces.deletedAt)))
    if (live.length >= MAX_WORKSPACES) throw Response.json({ error: LIMIT_MESSAGE }, { status: 409 })
    const color = nextColor(live.map((w) => w.color))
    const [ws] = await tx.insert(pgSchema.workspaces).values({ id: ulid(), userId, name, source: repoUrl ? "git" : "empty", repoUrl, defaultBranch, color }).returning()
    await tx.insert(pgSchema.sandboxes).values({ id: ulid(), workspaceId: ws.id, userId, vercelName: `ws_${ws.id.toLowerCase()}` })
    await audit(tx, { userId, actor: "user", action: "workspace.create", target: ws.id, data: { source: ws.source } })
    return ws
  })
}

export async function renameWorkspace(userId: string, id: string, name: string): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.update(pgSchema.workspaces).set({ name: name.trim().slice(0, 80) }).where(and(eq(pgSchema.workspaces.id, id), eq(pgSchema.workspaces.userId, userId)))
  })
}

/** Soft-deletes the row; Home is never deleted. The caller destroys the sandbox first (engine/sandbox.ts destroyWorkspaceSandbox). */
export async function deleteWorkspace(userId: string, id: string): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.update(pgSchema.workspaces).set({ deletedAt: new Date() }).where(and(eq(pgSchema.workspaces.id, id), eq(pgSchema.workspaces.userId, userId), eq(pgSchema.workspaces.isHome, false)))
    await audit(tx, { userId, actor: "user", action: "workspace.delete", target: id })
  })
}

export async function setEgress(userId: string, id: string, hosts: string[]): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.update(pgSchema.workspaces).set({ egressAllow: hosts }).where(and(eq(pgSchema.workspaces.id, id), eq(pgSchema.workspaces.userId, userId)))
    await audit(tx, { userId, actor: "user", action: "workspace.egress", target: id, data: { hosts } })
  })
}

export async function touchWorkspace(userId: string, id: string): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.update(pgSchema.workspaces).set({ lastOpenedAt: new Date() }).where(and(eq(pgSchema.workspaces.id, id), eq(pgSchema.workspaces.userId, userId)))
  })
}
