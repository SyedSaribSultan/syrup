import crypto from "node:crypto"
import { Sandbox } from "@vercel/sandbox"
import { eq } from "drizzle-orm"
import { track } from "../analytics"
import { openWith, sealWith, userDek } from "../cloud/crypto"
import { getWorkspace, touchWorkspace, type SandboxRow, type Workspace } from "../cloud/workspaces"
import { pgSchema, withUser } from "../db/pg"
import { env } from "../env"
import { slog } from "../log"

/**
 * SandboxEngine (docs/PHASE2.md): one Vercel Sandbox per workspace running
 * OpenCode. The browser talks to the sandbox directly with a per-start
 * password; this module owns creating, waking, starting the engine inside,
 * and stopping.
 *
 * Nothing secret is written to the sandbox filesystem. The password lives in
 * the engine process env and, encrypted, in the sandboxes row.
 */

export const OPENCODE_VERSION = "1.18.32"
const PORT = 4096
const IMAGE = "vercel/sandbox/universal"
const REGION = "fra1"
/** Sandbox auto-stops this long after the last heartbeat/extend. */
export const IDLE_MS = 10 * 60_000
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60_000
const HOME = "/vercel/sandbox"

export type Connection = {
  workspaceId: string
  baseUrl: string
  /** Value for the Authorization header. Held in browser memory only. */
  authorization: string
  /** Directory OpenCode treats as the project. */
  directory: string
  expiresAt: string | null
  engineVersion: string
  /** "cold" = fresh sandbox, "warm" = resumed snapshot, "hot" = engine already answering. */
  start: "cold" | "warm" | "hot"
  ms: number
}

function basic(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

function workDir(ws: Workspace) {
  return `${HOME}/${ws.source === "git" ? "repo" : "workspace"}`
}

/** OpenCode config for the sandbox. LSP off (biggest idle CPU burner), no auto-update, no sharing. */
function engineConfig(): string {
  return JSON.stringify({ lsp: false, autoupdate: false, share: "disabled" })
}

async function healthy(baseUrl: string, password: string, timeoutMs = 4000): Promise<{ version?: string } | null> {
  try {
    const res = await fetch(`${baseUrl}/global/health`, { headers: { authorization: basic(password) }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" })
    if (!res.ok) return null
    return (await res.json()) as { version?: string }
  } catch {
    return null
  }
}

async function waitHealthy(baseUrl: string, password: string, totalMs: number): Promise<{ version?: string }> {
  const until = Date.now() + totalMs
  let last: unknown
  while (Date.now() < until) {
    const h = await healthy(baseUrl, password, 3000)
    if (h) return h
    last = "no response"
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`OpenCode did not become healthy within ${Math.round(totalMs / 1000)} s (${String(last)})`)
}

async function installEngine(sb: Sandbox, ws: Workspace) {
  const t0 = Date.now()
  const steps: string[] = [`curl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION}`]
  if (ws.source === "git" && ws.repoUrl) steps.push(`git clone --depth 1 ${JSON.stringify(ws.repoUrl)} ${JSON.stringify(workDir(ws))}`)
  else steps.push(`mkdir -p ${JSON.stringify(workDir(ws))}`)
  const r = await sb.runCommand({ cmd: "bash", args: ["-lc", steps.join(" && ")], cwd: HOME })
  if (r.exitCode !== 0) {
    const err = (await r.stderr()).slice(-1500)
    throw new Error(`sandbox setup failed (exit ${r.exitCode}): ${err}`)
  }
  slog("engine", "sandbox.installed", { workspaceId: ws.id, ms: Date.now() - t0, version: OPENCODE_VERSION }, { directory: ws.id })
}

async function startEngine(sb: Sandbox, ws: Workspace, password: string) {
  const cors = [env.appUrl, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ""].filter(Boolean)
  await sb.runCommand({
    cmd: "bash",
    args: ["-lc", `exec "$HOME/.opencode/bin/opencode" serve --hostname 0.0.0.0 --port ${PORT} ${cors.map((c) => `--cors ${JSON.stringify(c)}`).join(" ")}`],
    cwd: workDir(ws),
    detached: true,
    env: { OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: engineConfig(), HOME },
  })
}

async function saveSandbox(userId: string, workspaceId: string, patch: Partial<typeof pgSchema.sandboxes.$inferInsert>) {
  await withUser(userId, async (tx) => {
    await tx.update(pgSchema.sandboxes).set({ ...patch, updatedAt: new Date() }).where(eq(pgSchema.sandboxes.workspaceId, workspaceId))
  })
}

async function storedPassword(userId: string, row: SandboxRow): Promise<string | null> {
  if (!row.passwordEnc) return null
  return withUser(userId, async (tx) => openWith(await userDek(tx, userId), row.passwordEnc!))
}

async function storePassword(userId: string, workspaceId: string, password: string) {
  await withUser(userId, async (tx) => {
    const dek = await userDek(tx, userId)
    await tx.update(pgSchema.sandboxes).set({ passwordEnc: sealWith(dek, password), updatedAt: new Date() }).where(eq(pgSchema.sandboxes.workspaceId, workspaceId))
  })
}

/**
 * Makes the workspace's sandbox run with a healthy OpenCode inside and returns
 * how the browser should connect. Idempotent: a hot engine is reused, a
 * stopped one is resumed from its snapshot, a missing one is created.
 */
export async function openWorkspace(userId: string, workspaceId: string): Promise<Connection> {
  const t0 = Date.now()
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws || !ws.sandbox) throw new Error("workspace not found")
  const row = ws.sandbox
  slog("engine", "sandbox.open", { workspaceId, name: row.vercelName, status: row.status }, { directory: workspaceId })
  await saveSandbox(userId, workspaceId, { status: "starting", lastError: null })

  try {
    let created = false
    const sb = await Sandbox.getOrCreate({
      name: row.vercelName,
      image: IMAGE,
      region: REGION,
      ports: [PORT],
      resources: { vcpus: row.vcpus },
      timeout: IDLE_MS,
      tags: { app: "syrup", workspace: workspaceId.slice(-12) },
      snapshotExpiration: SNAPSHOT_TTL_MS,
      keepLastSnapshots: { count: 1 },
      resume: true,
      onCreate: async (fresh) => {
        created = true
        await installEngine(fresh, ws)
      },
    })

    const baseUrl = sb.domain(PORT)
    let start: Connection["start"] = created ? "cold" : "warm"
    let password = created ? null : await storedPassword(userId, row)
    let version: string | undefined

    if (password) {
      const h = await healthy(baseUrl, password)
      if (h) {
        start = "hot"
        version = h.version
      } else password = null
    }
    if (!password) {
      password = crypto.randomBytes(24).toString("base64url")
      await startEngine(sb, ws, password)
      version = (await waitHealthy(baseUrl, password, 60_000)).version
      await storePassword(userId, workspaceId, password)
      await saveSandbox(userId, workspaceId, { lastSessionStartedAt: new Date() })
    }

    await saveSandbox(userId, workspaceId, { status: "running", region: sb.region, engineVersion: version ?? OPENCODE_VERSION })
    await touchWorkspace(userId, workspaceId)
    const ms = Date.now() - t0
    slog("engine", "sandbox.ready", { workspaceId, start, ms, version, expiresAt: sb.expiresAt }, { directory: workspaceId })
    await track(userId, "sandbox_started", { start, ms, created })
    return { workspaceId, baseUrl, authorization: basic(password), directory: workDir(ws), expiresAt: sb.expiresAt?.toISOString() ?? null, engineVersion: version ?? OPENCODE_VERSION, start, ms }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await saveSandbox(userId, workspaceId, { status: "error", lastError: message.slice(0, 1000) })
    slog("engine", "sandbox.open_failed", { workspaceId, err }, { level: "error", directory: workspaceId })
    await track(userId, "sandbox_error", { stage: "open" })
    throw err
  }
}

/** Extends the running session so the sandbox does not idle-stop while a tab is open. */
export async function heartbeat(userId: string, workspaceId: string): Promise<{ expiresAt: string | null }> {
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws?.sandbox) throw new Error("workspace not found")
  const sb = await Sandbox.get({ name: ws.sandbox.vercelName, resume: false })
  if (sb.status !== "running") return { expiresAt: null }
  const remaining = (sb.expiresAt?.getTime() ?? 0) - Date.now()
  if (remaining < IDLE_MS / 2) await sb.extendTimeout(IDLE_MS)
  return { expiresAt: (remaining < IDLE_MS / 2 ? new Date(Date.now() + IDLE_MS) : sb.expiresAt)?.toISOString() ?? null }
}

/** Stops the VM (filesystem is snapshotted) and records the session's cost. */
export async function stopWorkspace(userId: string, workspaceId: string): Promise<{ cpuMs: number } | null> {
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws?.sandbox) throw new Error("workspace not found")
  let sb: Sandbox
  try {
    sb = await Sandbox.get({ name: ws.sandbox.vercelName, resume: false })
  } catch {
    return null
  }
  if (sb.status !== "running") return null
  const r = await sb.stop()
  const seconds = ws.sandbox.lastSessionStartedAt ? Math.max(0, Math.round((Date.now() - ws.sandbox.lastSessionStartedAt.getTime()) / 1000)) : 0
  await saveSandbox(userId, workspaceId, {
    status: "stopped",
    lastSessionEndedAt: new Date(),
    totalSessionSeconds: ws.sandbox.totalSessionSeconds + seconds,
    totalCpuMs: ws.sandbox.totalCpuMs + Math.round(r.activeCpuDurationMs ?? 0),
  })
  slog("engine", "sandbox.stopped", { workspaceId, seconds, cpuMs: r.activeCpuDurationMs, snapshot: r.snapshot?.status }, { directory: workspaceId })
  await track(userId, "sandbox_stopped", { seconds, cpuMs: Math.round(r.activeCpuDurationMs ?? 0) })
  return { cpuMs: Math.round(r.activeCpuDurationMs ?? 0) }
}

/** Removes the VM and its snapshots. Used when a workspace is deleted. */
export async function destroyWorkspaceSandbox(userId: string, workspaceId: string): Promise<void> {
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws?.sandbox) return
  try {
    const sb = await Sandbox.get({ name: ws.sandbox.vercelName, resume: false })
    if (sb.status === "running") await sb.stop()
    await sb.delete()
    slog("engine", "sandbox.deleted", { workspaceId }, { directory: workspaceId })
  } catch (err) {
    // Never created, or already gone.
    slog("engine", "sandbox.delete_skipped", { workspaceId, err }, { level: "warn", directory: workspaceId })
  }
}
