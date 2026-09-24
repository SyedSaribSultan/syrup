import { and, desc, eq, isNull } from "drizzle-orm"
import { ulid } from "ulid"
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

export async function listWorkspaces(userId: string): Promise<(Workspace & { sandbox: SandboxRow | null })[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select()
      .from(pgSchema.workspaces)
      .leftJoin(pgSchema.sandboxes, eq(pgSchema.sandboxes.workspaceId, pgSchema.workspaces.id))
      .where(and(eq(pgSchema.workspaces.userId, userId), isNull(pgSchema.workspaces.deletedAt)))
      .orderBy(desc(pgSchema.workspaces.lastOpenedAt), desc(pgSchema.workspaces.createdAt))
    return rows.map((r) => ({ ...r.workspaces, sandbox: r.sandboxes }))
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
    const [ws] = await tx.insert(pgSchema.workspaces).values({ id: ulid(), userId, name, source: repoUrl ? "git" : "empty", repoUrl, defaultBranch }).returning()
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

/** Soft-deletes the row. The caller destroys the sandbox first (engine/sandbox.ts destroyWorkspaceSandbox). */
export async function deleteWorkspace(userId: string, id: string): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.update(pgSchema.workspaces).set({ deletedAt: new Date() }).where(and(eq(pgSchema.workspaces.id, id), eq(pgSchema.workspaces.userId, userId)))
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
