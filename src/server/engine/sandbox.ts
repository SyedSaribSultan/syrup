import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Sandbox } from "@vercel/sandbox"
import { eq } from "drizzle-orm"
import { track } from "../analytics"
import { openWith, sealWith, userDek } from "../cloud/crypto"
import { mintIngestToken } from "../cloud/ingest"
import { githubToken } from "../cloud/github"
import { activeKeyDetails } from "../cloud/keys"
import { syrupEngineConfig } from "./opencode"
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
/** Universal image: HOME and cwd are /vercel, user ubuntu (probed 2026-09-24). */
const HOME = "/vercel"

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

const SIDECAR_PORT = 4210
const SIDECAR_DIR = `${HOME}/.syrup`

/** OpenCode config for the sandbox: syrup router + memory MCP via the sidecar, LSP off (biggest idle CPU burner), no auto-update, no sharing. */
function engineConfig(secret: string): string {
  return JSON.stringify({ ...syrupEngineConfig(`http://127.0.0.1:${SIDECAR_PORT}/v1`, secret), instructions: [`${SIDECAR_DIR}/MEMORY.md`], lsp: false, autoupdate: false, share: "disabled" })
}

/** The bundled sidecar (built by sidecar/build.mjs before `next build`). */
function sidecarBundle(): { js: Buffer; hash: string } {
  const dir = path.join(process.cwd(), ".sidecar")
  const js = fs.readFileSync(path.join(dir, "sidecar.js"))
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "sidecar.json"), "utf8")) as { hash: string }
  return { js, hash: meta.hash }
}

/** Uploads the sidecar and starts it with the user's keys in process env, then waits for it to answer on loopback. */
async function startSidecar(sb: Sandbox, userId: string, workspaceId: string, password: string, secret: string) {
  const t0 = Date.now()
  const { js, hash } = sidecarBundle()
  await sb.runCommand({ cmd: "mkdir", args: ["-p", SIDECAR_DIR] })
  await sb.writeFiles([{ path: `${SIDECAR_DIR}/sidecar.js`, content: js }])
  const keys = await activeKeyDetails(userId)
  await sb.runCommand({
    cmd: "node",
    args: [`${SIDECAR_DIR}/sidecar.js`],
    cwd: SIDECAR_DIR,
    detached: true,
    env: {
      HOME,
      SYRUP_KEYS: JSON.stringify(keys),
      SYRUP_INTERNAL_SECRET: secret,
      SYRUP_INGEST_URL: env.appUrl,
      SYRUP_INGEST_TOKEN: mintIngestToken(userId, workspaceId),
      SYRUP_ROUTER_PORT: String(SIDECAR_PORT),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_URL: `http://127.0.0.1:${PORT}`,
    },
  })
  const wait = await sb.runCommand({ cmd: "bash", args: ["-lc", `for i in $(seq 1 75); do curl -sf http://127.0.0.1:${SIDECAR_PORT}/health >/dev/null && exit 0; sleep 0.2; done; exit 1`] })
  if (wait.exitCode !== 0) throw new Error("sidecar did not start within 15 s")
  slog("engine", "sidecar.started", { workspaceId, hash, ms: Date.now() - t0, providers: Object.keys(keys) }, { directory: workspaceId })
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

async function installEngine(sb: Sandbox, ws: Workspace, userId: string) {
  const t0 = Date.now()
  const steps: string[] = [`curl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION}`]
  const env: Record<string, string> = { HOME }
  if (ws.source === "git" && ws.repoUrl) {
    // A GitHub token (if any) reaches git through a one-shot credential helper that reads process env:
    // it is never written to .git/config, the shell history, or the snapshot.
    const token = ws.repoUrl.includes("github.com") ? await githubToken(userId) : null
    if (token) env.SYRUP_GIT_TOKEN = token
    const helper = token ? "-c credential.helper='!f() { echo username=x-access-token; echo \"password=$SYRUP_GIT_TOKEN\"; }; f'" : ""
    const branch = ws.defaultBranch ? `--branch ${JSON.stringify(ws.defaultBranch)}` : ""
    steps.push(`git ${helper} clone --depth 1 ${branch} ${JSON.stringify(ws.repoUrl)} ${JSON.stringify(workDir(ws))}`)
  } else steps.push(`mkdir -p ${JSON.stringify(workDir(ws))}`)
  const r = await sb.runCommand({ cmd: "bash", args: ["-lc", steps.join(" && ")], cwd: HOME, env })
  if (r.exitCode !== 0) {
    const err = (await r.stderr()).slice(-1500)
    if (/Authentication failed|could not read Username|Repository not found/i.test(err)) {
      throw new Error(`Could not clone the repository. If it is private, add a GitHub token under Account & privacy → Connections. (${err.trim().split("\n").pop()})`)
    }
    throw new Error(`sandbox setup failed (exit ${r.exitCode}): ${err}`)
  }
  slog("engine", "sandbox.installed", { workspaceId: ws.id, ms: Date.now() - t0, version: OPENCODE_VERSION }, { directory: ws.id })
}

/** Starts the sidecar, then OpenCode pointed at it. Both get a fresh per-start secret and password. */
async function startEngine(sb: Sandbox, ws: Workspace, userId: string, password: string) {
  const secret = crypto.randomBytes(24).toString("base64url")
  await startSidecar(sb, userId, ws.id, password, secret)
  const cors = [env.appUrl, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ""].filter(Boolean)
  await sb.runCommand({
    cmd: "bash",
    args: ["-lc", `exec "$HOME/.opencode/bin/opencode" serve --hostname 0.0.0.0 --port ${PORT} ${cors.map((c) => `--cors ${JSON.stringify(c)}`).join(" ")}`],
    cwd: workDir(ws),
    detached: true,
    env: { OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: engineConfig(secret), HOME },
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
  // Another request (a second tab) is already starting this sandbox: wait for it instead of racing it.
  if (row.status === "starting" && Date.now() - row.updatedAt.getTime() < 90_000) {
    const other = await waitForOther(userId, workspaceId, 90_000)
    if (other) return other
  }
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
        await installEngine(fresh, ws, userId)
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
      await startEngine(sb, ws, userId, password)
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
    const message = friendly(err instanceof Error ? err.message : String(err))
    await saveSandbox(userId, workspaceId, { status: "error", lastError: message.slice(0, 1000) })
    slog("engine", "sandbox.open_failed", { workspaceId, err }, { level: "error", directory: workspaceId })
    await track(userId, "sandbox_error", { stage: "open" })
    throw new Error(message)
  }
}

/** Polls until a concurrent open finishes, then reuses its engine if it is healthy. */
async function waitForOther(userId: string, workspaceId: string, totalMs: number): Promise<Connection | null> {
  const until = Date.now() + totalMs
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000))
    const ws = await getWorkspace(userId, workspaceId)
    const row = ws?.sandbox
    if (!ws || !row || row.status === "error") return null
    if (row.status === "running") {
      const password = await storedPassword(userId, row)
      if (!password) return null
      const sb = await Sandbox.get({ name: row.vercelName, resume: false })
      const baseUrl = sb.domain(PORT)
      const h = await healthy(baseUrl, password)
      if (!h) return null
      return { workspaceId, baseUrl, authorization: basic(password), directory: workDir(ws), expiresAt: sb.expiresAt?.toISOString() ?? null, engineVersion: h.version ?? OPENCODE_VERSION, start: "hot", ms: 0 }
    }
  }
  return null
}

/** Turns platform errors into something a person can act on. */
function friendly(message: string): string {
  if (/402|payment|quota|limit exceeded|too many sandboxes|concurrent/i.test(message)) return "The free sandbox pool is busy right now. Try again in a minute."
  if (/\b429\b/.test(message)) return "Too many starts in a short time. Wait a moment and try again."
  return message
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
