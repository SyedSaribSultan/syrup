import { eq } from "drizzle-orm"
import { pgSchema, withUser } from "../db/pg"
import { audit } from "./audit"
import { hint, openWith, sealWith, userDek } from "./crypto"

/**
 * GitHub access for private repositories (S5). One fine-grained personal
 * access token per user, envelope-encrypted like provider keys. It is used
 * at clone time through git's credential helper reading process env, so it
 * never lands in .git/config or a snapshot.
 */

export type RepoInfo = { fullName: string; defaultBranch: string; private: boolean; cloneUrl: string }

export async function saveGithubToken(userId: string, token: string): Promise<{ hint: string }> {
  const t = token.trim()
  if (!/^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/.test(t)) throw new Error("That does not look like a GitHub token (ghp_… or github_pat_…)")
  // Verify it works before storing it.
  const res = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "user-agent": "syrup" }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`GitHub rejected the token (${res.status})`)
  const h = hint(t)
  await withUser(userId, async (tx) => {
    const dek = await userDek(tx, userId)
    await tx.update(pgSchema.users).set({ githubTokenEnc: sealWith(dek, t), githubTokenHint: h }).where(eq(pgSchema.users.id, userId))
    await audit(tx, { userId, actor: "user", action: "github_token.set", data: { hint: h } })
  })
  return { hint: h }
}

export async function clearGithubToken(userId: string): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.update(pgSchema.users).set({ githubTokenEnc: null, githubTokenHint: null }).where(eq(pgSchema.users.id, userId))
    await audit(tx, { userId, actor: "user", action: "github_token.clear" })
  })
}

/** Plaintext token, or null. Only the sandbox launcher and repo validation call this. */
export async function githubToken(userId: string): Promise<string | null> {
  return withUser(userId, async (tx) => {
    const [u] = await tx.select({ enc: pgSchema.users.githubTokenEnc }).from(pgSchema.users).where(eq(pgSchema.users.id, userId))
    if (!u?.enc) return null
    return openWith(await userDek(tx, userId), u.enc)
  })
}

export async function githubTokenHint(userId: string): Promise<string | null> {
  return withUser(userId, async (tx) => {
    const [u] = await tx.select({ h: pgSchema.users.githubTokenHint }).from(pgSchema.users).where(eq(pgSchema.users.id, userId))
    return u?.h ?? null
  })
}

/** Looks a GitHub repo up so we can fail early with a clear message and record its default branch. */
export async function inspectGithubRepo(cloneUrl: string, token: string | null): Promise<RepoInfo | null> {
  const m = cloneUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
  if (!m) return null
  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "syrup", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 404) throw new Error(token ? "Repository not found, or your GitHub token cannot access it." : "Repository not found. If it is private, add a GitHub token under Account & privacy → Connections.")
  if (res.status === 401) throw new Error("Your GitHub token was rejected. Replace it under Account & privacy → Connections.")
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for that repository.`)
  const j = (await res.json()) as { full_name: string; default_branch: string; private: boolean; clone_url: string }
  return { fullName: j.full_name, defaultBranch: j.default_branch, private: j.private, cloneUrl: j.clone_url }
}
