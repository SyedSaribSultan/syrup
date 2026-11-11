import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { APIError, Sandbox } from "@vercel/sandbox"
import { and, eq, gte, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm"
import { track } from "../analytics"
import { audit } from "../cloud/audit"
import { openWith, sealWith, userDek } from "../cloud/crypto"
import { mintIngestToken } from "../cloud/ingest"
import { githubToken } from "../cloud/github"
import { activeKeyMeta } from "../cloud/keys"
import { skillBundle, type SkillBundle } from "../cloud/skills"
import { skillConfigJson } from "../skills-core"
import { egressPolicy } from "./egress"
import { sidecarStale, STOP_ENGINE_SCRIPT } from "./sidecar-version"
import { OPENCODE_VERSION, SANDBOX_CONFIG_DIRS } from "./config-dirs"
import { syrupEngineConfig } from "./opencode"
import { engineLive, IDLE_MS, SESSION_CAP_MS, sessionEndEstimate, sessionOpen, START_LEASE_MS, starting } from "./sandbox-state"
import { getWorkspace, touchWorkspace, type SandboxRow, type Workspace } from "../cloud/workspaces"
import { interruptOpenReplies } from "../cloud/history"
import { pgSchema, withUser, type PgTx } from "../db/pg"
import { env } from "../env"
import { slog } from "../log"
import { UserError } from "../user-error"

/**
 * SandboxEngine (docs/PHASE2.md): one Vercel Sandbox per workspace running
 * OpenCode. The browser talks to the sandbox directly with a per-start
 * password; this module owns creating, waking, starting the engine inside,
 * and stopping.
 *
 * Nothing secret is written to the sandbox filesystem. The password lives in
 * the engine process env and, encrypted, in the sandboxes row. Provider keys
 * never enter the sandbox at all: the sidecar's router reaches providers
 * through the app's LLM relay (/api/ingest/llm), which adds the key per call.
 */

export { OPENCODE_VERSION }
const PORT = 4096
const IMAGE = "vercel/sandbox/universal"
const REGION = "fra1"
export { IDLE_MS, SESSION_CAP_MS }
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
  /** The engine start this connection belongs to; the heartbeat reports the current one, so a tab can tell it was replaced. */
  sessionStartedAt: string | null
}

function basic(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

function workDir(ws: Workspace) {
  return `${HOME}/${ws.source === "git" ? "repo" : "workspace"}`
}

const SIDECAR_PORT = 4210
const SIDECAR_DIR = `${HOME}/.syrup`

/** syrup's OpenCode plugin (engine/syrup-plugin.ts), written next to the sidecar on every start. */
const PLUGIN_PATH = `${SIDECAR_DIR}/syrup-plugin.js`
/** The config-dir preparation (engine/config-dirs.ts), run before every `opencode serve`. */
const PREPARE_PATH = `${SIDECAR_DIR}/prepare-config-dirs.js`

/** OpenCode config for the sandbox: syrup router + memory MCP via the sidecar, syrup's plugin, LSP off (biggest idle CPU burner), no auto-update, no sharing. */
function engineConfig(secret: string): string {
  return JSON.stringify({
    ...syrupEngineConfig(`http://127.0.0.1:${SIDECAR_PORT}/v1`, secret, { plugin: `file://${PLUGIN_PATH}` }),
    instructions: [`${SIDECAR_DIR}/MEMORY.md`],
    lsp: false,
    autoupdate: false,
    share: "disabled",
  })
}

/** The bundled sidecar, plugin and config-dir script (built by sidecar/build.mjs before `next build`). The hash covers all three. */
function sidecarBundle(): { js: Buffer; plugin: Buffer; prepare: Buffer; hash: string } {
  const dir = path.join(process.cwd(), ".sidecar")
  const read = (f: string) => fs.readFileSync(path.join(dir, f))
  const meta = JSON.parse(read("sidecar.json").toString("utf8")) as { hash: string }
  return { js: read("sidecar.js"), plugin: read("syrup-plugin.js"), prepare: read("prepare-config-dirs.js"), hash: meta.hash }
}

/**
 * Prepares the engine's config dirs before OpenCode starts (docs/QUALITY.md Q0 hard rule): without it, loading the plugin
 * costs ~56 s on a workspace's first request in a sandbox. Runs on every start (a no-op once prepared); never fails the start.
 */
const PREPARE_CONFIG_DIRS = `node ${PREPARE_PATH} ${SANDBOX_CONFIG_DIRS.map((d) => `${d.create ? "--create" : "--existing"} ${d.dir}`).join(" ")} >/dev/null 2>&1 || true`

/** Skill permissions for the engine (OPENCODE_CONFIG). Re-read whenever an instance boots, so a reload applies changes without a restart. */
const SKILLS_CONFIG = `${SIDECAR_DIR}/engine-skills.json`

/**
 * The user's enabled skills as files for one writeFiles batch, into a fresh
 * staging folder, plus the shell step that swaps it in as the skills folder.
 * The swap holds a lock and skips a bundle older than the one already in
 * place, so overlapping pushes cannot interleave.
 */
function skillFiles(bundle: SkillBundle): { files: { path: string; content: Buffer }[]; apply: string } {
  const stamp = Date.now()
  const stage = `${SIDECAR_DIR}/skills-stage-${stamp}-${crypto.randomBytes(4).toString("hex")}`
  const files = [{ path: `${stage}.json`, content: Buffer.from(skillConfigJson(bundle.enabled)) }, ...bundle.files.map((f) => ({ path: `${stage}/${f.path}`, content: f.content }))]
  const dest = `${HOME}/.config/opencode/skills`
  const apply = [
    "exec 9>/tmp/syrup-skills.lock; flock -w 30 9 2>/dev/null",
    `if [ "$(cat ${SIDECAR_DIR}/skills.stamp 2>/dev/null || echo 0)" -gt ${stamp} ]; then rm -rf ${stage} ${stage}.json; exit 0; fi`,
    `mkdir -p ${stage} ${HOME}/.config/opencode && mv -f ${stage}.json ${SKILLS_CONFIG} && rm -rf ${dest} && mv ${stage} ${dest} && echo ${stamp} > ${SIDECAR_DIR}/skills.stamp`,
    `find ${SIDECAR_DIR} -maxdepth 1 -name 'skills-stage-*' -mmin +10 -exec rm -rf {} + 2>/dev/null; true`,
  ].join("\n")
  return { files, apply }
}

/**
 * Uploads the sidecar (and any extra files in the same batch) and starts it,
 * then waits for it to answer on loopback. Its env carries key metadata only
 * (provider, key id, tier), an ingest token bound to this engine start
 * (`sessionStart`, saved as the row's last_session_started_at before this runs)
 * and the per-start secret; the router's provider calls go through the app's
 * relay, which adds the keys.
 */
async function startSidecar(sb: Sandbox, userId: string, workspaceId: string, password: string, secret: string, sessionStart: number, extra: { path: string; content: Buffer }[] = []) {
  const t0 = Date.now()
  const { js, plugin, prepare, hash } = sidecarBundle()
  const [meta] = await Promise.all([activeKeyMeta(userId), sb.runCommand({ cmd: "mkdir", args: ["-p", SIDECAR_DIR] })])
  await sb.writeFiles([{ path: `${SIDECAR_DIR}/sidecar.js`, content: js }, { path: PLUGIN_PATH, content: plugin }, { path: PREPARE_PATH, content: prepare }, ...extra])
  await sb.runCommand({
    cmd: "node",
    args: [`${SIDECAR_DIR}/sidecar.js`],
    cwd: SIDECAR_DIR,
    detached: true,
    env: {
      HOME,
      SYRUP_ROUTER_KEYS: JSON.stringify(meta),
      SYRUP_INTERNAL_SECRET: secret,
      SYRUP_INGEST_URL: env.appUrl,
      // The sidecar never outlives its sandbox's session (SESSION_CAP_MS), so the token need not either. It is readable
      // inside the sandbox; it reaches the user's providers only through the relay's two endpoints, never their keys.
      // Bound to this engine start: stopping or deleting the workspace, or starting it again, ends it at the relay.
      SYRUP_INGEST_TOKEN: mintIngestToken(userId, workspaceId, INGEST_TOKEN_TTL_MS, sessionStart),
      // Reported on the sidecar's /health, so a sandbox reused after a deploy is restarted onto the new sidecar.
      SYRUP_SIDECAR_BUNDLE: hash,
      SYRUP_ROUTER_PORT: String(SIDECAR_PORT),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_URL: `http://127.0.0.1:${PORT}`,
      // Gzip large LLM request bodies to the relay. Off until a production probe shows Vercel passes them through intact.
      ...(process.env.SYRUP_RELAY_GZIP === "1" ? { SYRUP_RELAY_GZIP: "1" } : {}),
    },
  })
  const wait = await sb.runCommand({ cmd: "bash", args: ["-lc", `for i in $(seq 1 75); do curl -sf http://127.0.0.1:${SIDECAR_PORT}/health >/dev/null && exit 0; sleep 0.2; done; exit 1`] })
  if (wait.exitCode !== 0) throw new Error("sidecar did not start within 15 s")
  slog("engine", "sidecar.started", { workspaceId, hash, ms: Date.now() - t0, providers: Object.keys(meta) }, { directory: workspaceId })
}

/** The sidecar's own /health inside the sandbox (its port is loopback only). Null when the check itself could not run. */
async function runningSidecar(sb: Sandbox): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    const r = await sb.runCommand({ cmd: "curl", args: ["-sf", "--max-time", "2", `http://127.0.0.1:${SIDECAR_PORT}/health`] })
    return { exitCode: r.exitCode, stdout: r.exitCode === 0 ? await r.stdout() : "" }
  } catch {
    return null
  }
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
  } else {
    // An empty workspace (Home, Scratch) still gets a repository: the engine snapshots only git worktrees, and without
    // them the Changes panel and revert do nothing. No commits are made.
    steps.push(`mkdir -p ${JSON.stringify(workDir(ws))} && git -C ${JSON.stringify(workDir(ws))} -c init.defaultBranch=main init -q`)
  }
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

/** Starts the sidecar, then OpenCode pointed at it with the user's skills in place. Both get a fresh per-start secret and password. */
async function startEngine(sb: Sandbox, ws: Workspace, userId: string, password: string, sessionStart: number) {
  const secret = crypto.randomBytes(24).toString("base64url")
  const skills = skillFiles(await skillBundle(userId))
  await startSidecar(sb, userId, ws.id, password, secret, sessionStart, skills.files)
  const cors = [env.appUrl, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ""].filter(Boolean)
  await sb.runCommand({
    cmd: "bash",
    // `[ -e .git ] || git init`: workspaces created before empty ones got a repository catch up on their next start.
    // The config dirs are prepared after the skills swap (which creates ~/.config/opencode) and before OpenCode reads them.
    args: ["-lc", `(${skills.apply})\n([ -e .git ] || git -c init.defaultBranch=main init -q)\n${PREPARE_CONFIG_DIRS}\nexec "$HOME/.opencode/bin/opencode" serve --hostname 0.0.0.0 --port ${PORT} ${cors.map((c) => `--cors ${JSON.stringify(c)}`).join(" ")}`],
    cwd: workDir(ws),
    detached: true,
    // OPENCODE_ENABLE_EXA: web search, off by default in OpenCode.
    env: { OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: engineConfig(secret), OPENCODE_CONFIG: SKILLS_CONFIG, HOME, OPENCODE_ENABLE_EXA: "1" },
  })
}

const sb_ = pgSchema.sandboxes

/** Not mid-start under a live lease. Writes that end or overwrite a start take this guard, so they cannot stomp one. */
const notStarting = (): SQL => or(ne(sb_.status, "starting"), isNull(sb_.startUntil), lt(sb_.startUntil, sql`now()`))!
/** The workspace is not deleted and the account is neither blocked nor pending deletion. Every start and finish checks it. */
const mayRun = (): SQL =>
  sql`exists (select 1 from workspaces w where w.id = ${sb_.workspaceId} and w.deleted_at is null) and not exists (select 1 from users u where u.id = ${sb_.userId} and (u.blocked_at is not null or u.deleted_at is not null))`

async function saveSandbox(userId: string, workspaceId: string, patch: Partial<typeof sb_.$inferInsert>, guard?: SQL) {
  await withUser(userId, async (tx) => {
    await tx.update(sb_).set({ ...patch, updatedAt: new Date() }).where(and(eq(sb_.workspaceId, workspaceId), guard))
  })
}

/**
 * Accounts one finished engine session exactly once: adds its seconds to total_session_seconds and writes a
 * `sandbox.session` audit row, which the daily cap sums. The update is conditional on the session still being open,
 * so two requests closing the same session (heartbeat and stop) count it once. Replies the engine never finished are
 * marked interrupted. A patch that sets a status never lands on a live start.
 */
async function closeSession(userId: string, workspaceId: string, row: SandboxRow, endAt: number, patch: Partial<typeof sb_.$inferInsert> = {}) {
  const guard = patch.status ? notStarting() : undefined
  if (!sessionOpen(row)) {
    if (Object.keys(patch).length) await saveSandbox(userId, workspaceId, patch, guard)
    return
  }
  const startedAt = row.lastSessionStartedAt!
  const end = Math.max(startedAt.getTime(), Math.min(endAt, startedAt.getTime() + SESSION_CAP_MS))
  const seconds = Math.round((end - startedAt.getTime()) / 1000)
  await withUser(userId, async (tx) => {
    const done = await tx
      .update(sb_)
      .set({ ...patch, lastSessionEndedAt: new Date(end), totalSessionSeconds: sql`${sb_.totalSessionSeconds} + ${seconds}`, updatedAt: new Date() })
      .where(and(eq(sb_.workspaceId, workspaceId), eq(sb_.lastSessionStartedAt, startedAt), or(isNull(sb_.lastSessionEndedAt), lt(sb_.lastSessionEndedAt, sb_.lastSessionStartedAt)), guard))
      .returning({ id: sb_.id })
    if (done.length) {
      await audit(tx, { userId, actor: "system", action: "sandbox.session", target: workspaceId, data: { seconds, startedAt: startedAt.toISOString() } })
      await interruptOpenReplies(tx, userId, workspaceId, new Date(end))
    } else if (Object.keys(patch).length) await tx.update(sb_).set({ ...patch, updatedAt: new Date() }).where(and(eq(sb_.workspaceId, workspaceId), guard))
  })
}

export type SandboxUsage = { usedSeconds: number; running: number }

/** Today's (UTC) sandbox seconds for a user, and how many of their other sandboxes are running or starting. */
async function usageIn(tx: PgTx, userId: string, exceptWorkspaceId?: string): Promise<SandboxUsage> {
  const now = Date.now()
  const day = new Date(now)
  day.setUTCHours(0, 0, 0, 0)
  const a = pgSchema.auditLog
  const [closed] = await tx
    .select({ seconds: sql<string | null>`sum((${a.data}->>'seconds')::int)` })
    .from(a)
    .where(and(eq(a.userId, userId), eq(a.action, "sandbox.session"), gte(a.createdAt, day)))
  const rows = await tx.select().from(sb_).where(eq(sb_.userId, userId))
  let usedSeconds = Number(closed?.seconds ?? 0)
  let running = 0
  for (const r of rows) {
    if (sessionOpen(r)) usedSeconds += Math.max(0, sessionEndEstimate(r, now) - Math.max(r.lastSessionStartedAt!.getTime(), day.getTime())) / 1000
    if (r.workspaceId === exceptWorkspaceId) continue
    // A start under a live lease, or a running row whose session could still be up: a stale row does not count.
    if (engineLive(r, now)) running++
  }
  return { usedSeconds: Math.round(usedSeconds), running }
}

export async function sandboxUsage(userId: string, exceptWorkspaceId?: string): Promise<SandboxUsage> {
  return withUser(userId, (tx) => usageIn(tx, userId, exceptWorkspaceId))
}

function hours(seconds: number): string {
  const h = seconds / 3600
  return h >= 1 ? `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"}` : `${Math.round(seconds / 60)} minutes`
}

/** Thrown 429 when a new sandbox start would pass a cap (audit 2026-10-15 H2). */
async function enforceSandboxCaps(tx: PgTx, userId: string, workspaceId: string) {
  const daily = env.sandboxDailySeconds
  const max = env.sandboxMaxRunning
  if (daily <= 0 && max <= 0) return
  const u = await usageIn(tx, userId, workspaceId)
  if (daily > 0 && u.usedSeconds >= daily) {
    slog("engine", "sandbox.cap_daily", { workspaceId, usedSeconds: u.usedSeconds, cap: daily }, { level: "warn", directory: workspaceId })
    throw Response.json({ error: `You've used today's ${hours(daily)} of workspace time. It resets at midnight UTC.`, code: "sandbox_daily_cap" }, { status: 429 })
  }
  if (max > 0 && u.running >= max) {
    slog("engine", "sandbox.cap_running", { workspaceId, running: u.running, cap: max }, { level: "warn", directory: workspaceId })
    throw Response.json(
      { error: `You already have ${u.running} workspace${u.running === 1 ? "" : "s"} running (the limit is ${max}). Stop one with "Stop workspace" in its sidebar, or wait about 10 minutes for an idle one to sleep.`, code: "sandbox_running_cap" },
      { status: 429 },
    )
  }
}

/**
 * Takes the start lease (compare-and-set): the row becomes "starting", owned by `owner` until the lease ends. Caps are
 * counted under a per-user lock in the same transaction, so two opens at once cannot both pass them. "busy" when
 * another opener holds a live lease on this workspace.
 */
async function claimStart(userId: string, workspaceId: string, owner: string, exempt: boolean): Promise<SandboxRow | "busy"> {
  return withUser(userId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sandbox-start:${userId}`}))`)
    const [cur] = await tx.select().from(sb_).where(eq(sb_.workspaceId, workspaceId))
    if (cur && starting(cur)) return "busy"
    // Caps first, before anything starts: a thrown 429 Response reaches the route handler as is.
    if (!exempt) await enforceSandboxCaps(tx, userId, workspaceId)
    const [row] = await tx
      .update(sb_)
      .set({ status: "starting", startOwner: owner, startUntil: sql`now() + ${`${START_LEASE_MS} milliseconds`}::interval`, lastError: null, updatedAt: new Date() })
      .where(and(eq(sb_.workspaceId, workspaceId), notStarting(), mayRun()))
      .returning()
    if (row) return row
    const [again] = await tx.select().from(sb_).where(eq(sb_.workspaceId, workspaceId))
    if (again && starting(again)) return "busy"
    throw new UserError("workspace not found", 404)
  })
}

/** The opener lost its lease: the workspace was stopped, deleted or its account blocked while it was starting. */
class LostLease extends Error {}

/** A write that lands only while `owner` still holds the start lease and the workspace may run; LostLease otherwise. */
async function saveIfOwner(tx: PgTx, workspaceId: string, owner: string, patch: Partial<typeof sb_.$inferInsert>) {
  const done = await tx
    .update(sb_)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(sb_.workspaceId, workspaceId), eq(sb_.startOwner, owner), eq(sb_.status, "starting"), mayRun()))
    .returning({ id: sb_.id })
  if (!done.length) throw new LostLease()
}

/** Ends a lease without starting: the start was taken back. Only this opener's own row state is touched. */
const leaseCleared = { startOwner: null, startUntil: null } as const

async function storedPassword(userId: string, row: SandboxRow): Promise<string | null> {
  if (!row.passwordEnc) return null
  return withUser(userId, async (tx) => openWith(await userDek(tx, userId), row.passwordEnc!))
}

/**
 * Makes the workspace's sandbox run with a healthy OpenCode inside and returns
 * how the browser should connect. Idempotent: a hot engine is reused, a
 * stopped one is resumed from its snapshot, a missing one is created. Only the
 * opener holding the start lease starts the engine; a second open waits for it.
 */
export async function openWorkspace(userId: string, workspaceId: string, opts: { exempt?: boolean } = {}): Promise<Connection> {
  const t0 = Date.now()
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws || !ws.sandbox) throw new UserError("workspace not found", 404)
  slog("engine", "sandbox.open", { workspaceId, name: ws.sandbox.vercelName, status: ws.sandbox.status }, { directory: workspaceId })
  const owner = crypto.randomUUID()
  let row = await claimStart(userId, workspaceId, owner, !!opts.exempt)
  if (row === "busy") {
    // Another request (a second tab) is already starting this sandbox: wait for it instead of racing it.
    const other = await waitForOther(userId, workspaceId)
    if (other) return other
    row = await claimStart(userId, workspaceId, owner, !!opts.exempt)
    if (row === "busy") throw new UserError("This workspace is still starting in another tab. Try again in a moment.", 409)
  }
  const claimed = row

  let sb: Sandbox | null = null
  try {
    let created = false
    // No provider hosts: the sandbox reaches providers only through the app's relay (the ingest host is always allowed).
    const networkPolicy = egressPolicy([], ws.egressAllow)
    sb = await Sandbox.getOrCreate({
      name: claimed.vercelName,
      image: IMAGE,
      region: REGION,
      ports: [PORT],
      resources: { vcpus: claimed.vcpus },
      timeout: IDLE_MS,
      networkPolicy,
      tags: { app: "syrup", workspace: workspaceId.slice(-12) },
      snapshotExpiration: SNAPSHOT_TTL_MS,
      keepLastSnapshots: { count: 1 },
      resume: true,
      onCreate: async (fresh) => {
        created = true
        await installEngine(fresh, ws, userId)
      },
    })

    // Existing sandboxes keep their creation-time policy; apply the current one (the allow-list may have changed).
    if (!created) await sb.update({ networkPolicy })
    const baseUrl = sb.domain(PORT)
    let start: Connection["start"] = created ? "cold" : "warm"
    let password = created ? null : await storedPassword(userId, claimed)
    let version: string | undefined
    let sessionStart = claimed.lastSessionStartedAt

    if (password) {
      // The sidecar is checked alongside OpenCode: one started by an earlier deploy speaks an older protocol (and, before
      // the LLM relay, held provider keys in its env), so the engine is restarted onto this deploy's sidecar.
      const [h, sidecar] = await Promise.all([healthy(baseUrl, password), runningSidecar(sb)])
      if (h && !sidecarStale(sidecar, sidecarBundle().hash)) {
        start = "hot"
        version = h.version
      } else {
        if (h) slog("engine", "sidecar.outdated", { workspaceId, answer: sidecar?.stdout.slice(0, 200) ?? null }, { level: "warn", directory: workspaceId })
        // Whatever still runs from the last start must go, or the new sidecar cannot take its port.
        await sb.runCommand({ cmd: "bash", args: ["-c", STOP_ENGINE_SCRIPT] }).catch(() => {})
        password = null
      }
    }
    const fresh = !password
    if (!password) {
      password = crypto.randomBytes(24).toString("base64url")
      sessionStart = new Date()
      // The previous engine session, if a heartbeat or stop never accounted it, ends now at the latest. A brand-new
      // workspace has no previous session (lastSessionStartedAt is null), so there is nothing to close.
      if (sessionOpen(claimed)) await closeSession(userId, workspaceId, claimed, sessionEndEstimate(claimed))
      // Saved before the sidecar starts: its ingest token is bound to this stamp, and the relay checks it from the first call.
      const idleUntil = sb.expiresAt ?? new Date(Date.now() + IDLE_MS)
      await withUser(userId, (tx) => saveIfOwner(tx, workspaceId, owner, { lastSessionStartedAt: sessionStart, idleUntil }))
      await startEngine(sb, ws, userId, password, sessionStart.getTime())
      version = (await waitHealthy(baseUrl, password, 60_000)).version
      // A healthy OpenCode still builds its per-folder instance (file watchers, skills, ~3 s) on the first request
      // for the folder. Ask for it now, so a prewarmed workspace is truly ready when the first message comes.
      void fetch(`${baseUrl}/session?directory=${encodeURIComponent(workDir(ws))}`, { headers: { authorization: basic(password) }, signal: AbortSignal.timeout(20_000) }).catch(() => {})
    }

    // Running, with the password, in one conditional write: only the lease holder finishes the start.
    const finalPassword = password
    await withUser(userId, async (tx) => {
      const patch: Partial<typeof sb_.$inferInsert> = { status: "running", ...leaseCleared, region: sb!.region, engineVersion: version ?? OPENCODE_VERSION }
      // A new engine reads the current skills itself; a reload still owed to the old one is moot.
      if (fresh) Object.assign(patch, { passwordEnc: sealWith(await userDek(tx, userId), finalPassword), skillsReloadDueAt: null })
      await saveIfOwner(tx, workspaceId, owner, patch)
    })
    await touchWorkspace(userId, workspaceId)
    const ms = Date.now() - t0
    slog("engine", "sandbox.ready", { workspaceId, start, ms, version, expiresAt: sb.expiresAt }, { directory: workspaceId })
    await track(userId, "sandbox_started", { start, ms, created })
    return { workspaceId, baseUrl, authorization: basic(password), directory: workDir(ws), expiresAt: sb.expiresAt?.toISOString() ?? null, engineVersion: version ?? OPENCODE_VERSION, start, ms, sessionStartedAt: sessionStart?.toISOString() ?? null }
  } catch (err) {
    if (err instanceof LostLease) {
      await abandonStart(userId, workspaceId, owner, sb)
      throw new UserError("This workspace was stopped while it was starting.", 409)
    }
    const message = friendly(err instanceof Error ? err.message : String(err))
    await withUser(userId, (tx) => saveIfOwner(tx, workspaceId, owner, { status: "error", ...leaseCleared, lastError: message.slice(0, 1000) })).catch(() => {})
    slog("engine", "sandbox.open_failed", { workspaceId, err }, { level: "error", directory: workspaceId })
    await track(userId, "sandbox_error", { stage: "open" })
    // Already phrased for the person (friendly()), and shown as the workspace's last error anyway.
    throw new UserError(message, 500)
  }
}

/**
 * An open whose lease was taken back (stop, block, workspace delete) stops what it started. A deleted workspace's VM is
 * destroyed outright, since the delete may have run before this open created it. Someone else's newer start is left alone.
 */
async function abandonStart(userId: string, workspaceId: string, owner: string, sb: Sandbox | null) {
  const [cur] = await withUser(userId, (tx) =>
    tx.select({ row: sb_, deletedAt: pgSchema.workspaces.deletedAt }).from(sb_).innerJoin(pgSchema.workspaces, eq(pgSchema.workspaces.id, sb_.workspaceId)).where(eq(sb_.workspaceId, workspaceId)),
  )
  if (cur && starting(cur.row) && cur.row.startOwner !== owner) return
  slog("engine", "sandbox.start_abandoned", { workspaceId, deleted: !!cur?.deletedAt }, { level: "warn", directory: workspaceId })
  if (cur?.deletedAt) {
    if (await destroyVm(cur.row.vercelName, workspaceId)) await saveSandbox(userId, workspaceId, { vmDeletedAt: new Date() })
  } else if (sb) await sb.stop().catch(() => {})
  if (cur) await closeSession(userId, workspaceId, cur.row, Date.now(), { status: "stopped", passwordEnc: null })
}

/** Polls until a concurrent open finishes, then reuses its engine if it is healthy. Null when it did not end running. */
async function waitForOther(userId: string, workspaceId: string): Promise<Connection | null> {
  // Within the open route's own time limit (180 s); a lease that outlives it belongs to a dead opener and lapses.
  const until = Date.now() + 150_000
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000))
    const ws = await getWorkspace(userId, workspaceId)
    const row = ws?.sandbox
    if (!ws || !row) return null
    if (starting(row)) continue
    if (row.status !== "running") return null
    const password = await storedPassword(userId, row)
    if (!password) return null
    const sb = await Sandbox.get({ name: row.vercelName, resume: false })
    const baseUrl = sb.domain(PORT)
    const h = await healthy(baseUrl, password)
    if (!h) return null
    return { workspaceId, baseUrl, authorization: basic(password), directory: workDir(ws), expiresAt: sb.expiresAt?.toISOString() ?? null, engineVersion: h.version ?? OPENCODE_VERSION, start: "hot", ms: 0, sessionStartedAt: row.lastSessionStartedAt?.toISOString() ?? null }
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
export type Heartbeat = { running: boolean; expiresAt: string | null; sessionStartedAt: string | null; sessionCapMs: number }
/** The sidecar's ingest token: one session plus a margin (was 2 h). A sidecar never outlives its session. */
const INGEST_TOKEN_TTL_MS = SESSION_CAP_MS + 15 * 60_000

export async function heartbeat(userId: string, workspaceId: string, opts: { exempt?: boolean } = {}): Promise<Heartbeat> {
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws?.sandbox) throw new UserError("workspace not found", 404)
  let sb: Sandbox
  try {
    sb = await Sandbox.get({ name: ws.sandbox.vercelName, resume: false })
  } catch {
    return { running: false, expiresAt: null, sessionStartedAt: null, sessionCapMs: SESSION_CAP_MS }
  }
  const row = ws.sandbox
  const startedAt = row.lastSessionStartedAt?.toISOString() ?? null
  if (sb.status !== "running") {
    // The VM idled out: the session ended when it stopped, and its password with it. A start in progress is left alone.
    if (sessionOpen(row)) await closeSession(userId, workspaceId, row, Math.min(sb.statusUpdatedAt?.getTime() ?? Date.now(), sessionEndEstimate(row)), { status: "stopped", passwordEnc: null })
    else if (row.status === "running") await saveSandbox(userId, workspaceId, { status: "stopped", passwordEnc: null }, notStarting())
    return { running: false, expiresAt: null, sessionStartedAt: startedAt, sessionCapMs: SESSION_CAP_MS }
  }
  if (row.skillsReloadDueAt) await retrySkillsReload(userId, ws, row, sb)
  const remaining = (sb.expiresAt?.getTime() ?? 0) - Date.now()
  let expiresAt = sb.expiresAt ?? null
  if (remaining < IDLE_MS / 2) {
    // Past the daily cap the sandbox is no longer kept awake: it sleeps at its idle timeout and the next open says why.
    if (!opts.exempt && env.sandboxDailySeconds > 0) {
      const u = await sandboxUsage(userId, workspaceId)
      if (u.usedSeconds >= env.sandboxDailySeconds) {
        slog("engine", "sandbox.cap_daily", { workspaceId, usedSeconds: u.usedSeconds, cap: env.sandboxDailySeconds, at: "heartbeat" }, { level: "warn", directory: workspaceId })
        throw Response.json({ error: `You've used today's ${hours(env.sandboxDailySeconds)} of workspace time. This workspace will sleep within ${Math.max(1, Math.round(remaining / 60_000))} minutes; it resets at midnight UTC.`, code: "sandbox_daily_cap" }, { status: 429 })
      }
    }
    await sb.extendTimeout(IDLE_MS)
    // The timer runs IDLE_MS past where it stood; the session's end estimate counts from there.
    expiresAt = new Date(Math.max(Date.now(), sb.expiresAt?.getTime() ?? 0) + IDLE_MS)
    await saveSandbox(userId, workspaceId, { idleUntil: expiresAt })
  }
  return { running: true, expiresAt: expiresAt?.toISOString() ?? null, sessionStartedAt: startedAt, sessionCapMs: SESSION_CAP_MS }
}

/** Ops hook (admin probe): one shell command inside the running sandbox. */
export async function runInWorkspace(userId: string, workspaceId: string, command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws?.sandbox) throw new UserError("workspace not found", 404)
  const sb = await Sandbox.get({ name: ws.sandbox.vercelName })
  const r = await sb.runCommand({ cmd: "bash", args: ["-lc", command], cwd: workDir(ws) })
  return { exitCode: r.exitCode, stdout: (await r.stdout()).slice(-4000), stderr: (await r.stderr()).slice(-2000) }
}

/**
 * Stops the VM (filesystem is snapshotted) and records the session's cost. A start in progress is stopped too: its
 * lease is taken back, so the opener stops what it started. When the VM had already stopped by itself, the row is
 * brought in line all the same. Null when nothing was running.
 */
export async function stopWorkspace(userId: string, workspaceId: string): Promise<{ cpuMs: number } | null> {
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws?.sandbox) throw new UserError("workspace not found", 404)
  await saveSandbox(userId, workspaceId, { status: "stopped", ...leaseCleared }, eq(sb_.status, "starting"))
  let sb: Sandbox | null = null
  try {
    sb = await Sandbox.get({ name: ws.sandbox.vercelName, resume: false })
  } catch {
    // Never created, or already gone.
  }
  const r = sb?.status === "running" ? await sb.stop() : null
  const cpuMs = Math.round(r?.activeCpuDurationMs ?? 0)
  const row = (await getWorkspace(userId, workspaceId))?.sandbox ?? ws.sandbox
  const end = r ? Date.now() : Math.min(sb?.statusUpdatedAt?.getTime() ?? Date.now(), sessionEndEstimate(row))
  // The password dies with the session; the next start mints a new one. The session's seconds are counted once.
  await closeSession(userId, workspaceId, row, end, { status: "stopped", passwordEnc: null, totalCpuMs: row.totalCpuMs + cpuMs })
  if (!r) return null
  const seconds = row.lastSessionStartedAt ? Math.max(0, Math.round((Date.now() - row.lastSessionStartedAt.getTime()) / 1000)) : 0
  slog("engine", "sandbox.stopped", { workspaceId, seconds, cpuMs, snapshot: r.snapshot?.status }, { directory: workspaceId })
  await track(userId, "sandbox_stopped", { seconds, cpuMs })
  return { cpuMs }
}

/** Stops every workspace of a user (blocked, or deleting their account). Returns how many VMs were running. */
export async function stopAllWorkspaces(userId: string): Promise<number> {
  const rows = await withUser(userId, (tx) => tx.select({ workspaceId: sb_.workspaceId }).from(sb_).where(eq(sb_.userId, userId)))
  let stopped = 0
  for (const r of rows) {
    try {
      if (await stopWorkspace(userId, r.workspaceId)) stopped++
    } catch (err) {
      slog("engine", "sandbox.stop_failed", { workspaceId: r.workspaceId, err }, { level: "warn", directory: r.workspaceId })
    }
  }
  return stopped
}

/** Applies a changed allow-list to a running sandbox immediately. */
export async function applyEgress(userId: string, workspaceId: string): Promise<void> {
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws?.sandbox) return
  try {
    const sb = await Sandbox.get({ name: ws.sandbox.vercelName, resume: false })
    if (sb.status !== "running") return
    await sb.update({ networkPolicy: egressPolicy([], ws.egressAllow) })
    slog("engine", "sandbox.egress_updated", { workspaceId, hosts: ws.egressAllow.length }, { directory: workspaceId })
  } catch (err) {
    slog("engine", "sandbox.egress_update_failed", { workspaceId, err }, { level: "warn", directory: workspaceId })
  }
}

/**
 * Pushes the user's current skills to every sandbox of theirs whose VM is running (asked of the platform, not the row):
 * files and permissions are swapped in right away, then the engine reloads once no session is busy (disposing an
 * instance stops its running turns). A sandbox still busy after a minute is marked, and its next heartbeat reloads it
 * once it is idle.
 */
export async function syncSkills(userId: string): Promise<void> {
  let rows: { ws: Workspace; sb: SandboxRow }[]
  let bundle: SkillBundle
  try {
    rows = await withUser(userId, (tx) =>
      tx
        .select({ ws: pgSchema.workspaces, sb: sb_ })
        .from(sb_)
        .innerJoin(pgSchema.workspaces, eq(pgSchema.workspaces.id, sb_.workspaceId))
        .where(and(eq(sb_.userId, userId), isNull(pgSchema.workspaces.deletedAt))),
    )
    if (rows.length === 0) return
    bundle = await skillBundle(userId)
  } catch (err) {
    return slog("engine", "skills.sync_failed", { err }, { level: "warn" })
  }
  await Promise.all(
    rows.map(async ({ ws, sb: row }) => {
      try {
        let sb: Sandbox
        try {
          sb = await Sandbox.get({ name: row.vercelName, resume: false })
        } catch {
          return
        }
        if (sb.status !== "running") return
        const { files, apply } = skillFiles(bundle)
        await sb.writeFiles(files)
        const r = await sb.runCommand({ cmd: "bash", args: ["-lc", apply] })
        if (r.exitCode !== 0) throw new Error(`skills swap failed (exit ${r.exitCode}): ${(await r.stderr()).slice(-500)}`)
        const password = await storedPassword(userId, row)
        if (!password) return
        const reloaded = await reloadWhenIdle(sb.domain(PORT), password, workDir(ws), ws.id, 60_000)
        await saveSandbox(userId, ws.id, { skillsReloadDueAt: reloaded ? null : new Date() })
      } catch (err) {
        slog("engine", "skills.sync_failed", { workspaceId: ws.id, err }, { level: "warn", directory: ws.id })
      }
    }),
  )
}

/** A skills reload the engine still owes (it was busy): done now if no session is busy, else left for the next heartbeat. */
async function retrySkillsReload(userId: string, ws: Workspace, row: SandboxRow, sb: Sandbox) {
  try {
    const password = await storedPassword(userId, row)
    const reloaded = !password || (await reloadWhenIdle(sb.domain(PORT), password, workDir(ws), ws.id, 0))
    if (reloaded) await saveSandbox(userId, ws.id, { skillsReloadDueAt: null })
  } catch (err) {
    slog("engine", "skills.reload_failed", { workspaceId: ws.id, err }, { level: "warn", directory: ws.id })
  }
}

/** Reloads the engine once no session is busy, waiting up to `waitMs`. False when it was still busy (the reload is deferred). */
async function reloadWhenIdle(baseUrl: string, password: string, directory: string, workspaceId: string, waitMs: number): Promise<boolean> {
  const headers = { authorization: basic(password) }
  const until = Date.now() + waitMs
  for (;;) {
    const res = await fetch(`${baseUrl}/session/status?directory=${encodeURIComponent(directory)}`, { headers, cache: "no-store", signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`engine: session status ${res.status}`)
    const status = (await res.json()) as Record<string, { type: string }>
    if (!Object.values(status).some((st) => st.type !== "idle")) break
    if (Date.now() >= until) {
      slog("engine", "reload.deferred", { reason: "skills changed", workspaceId }, { directory: workspaceId })
      return false
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  const res = await fetch(`${baseUrl}/global/dispose`, { method: "POST", headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`engine: could not reload (${res.status})`)
  slog("engine", "instance.reloaded", { reason: "skills changed", workspaceId }, { directory: workspaceId })
  return true
}

/**
 * Deletes a VM and its snapshots. True when it is gone (deleted now, or it never existed); false when the platform
 * refused, so the caller keeps it on record and the nightly cron tries again.
 */
export async function destroyVm(name: string, workspaceId: string): Promise<boolean> {
  try {
    const sb = await Sandbox.get({ name, resume: false })
    if (sb.status === "running") await sb.stop()
    await sb.delete()
    slog("engine", "sandbox.deleted", { workspaceId }, { directory: workspaceId })
  } catch (err) {
    if (err instanceof APIError && err.response.status === 404) return true
    slog("engine", "sandbox.delete_failed", { workspaceId, err }, { level: "warn", directory: workspaceId })
    return false
  }
  return true
}

/**
 * Removes the VM and its snapshots, when a workspace is deleted (after the row is soft-deleted, so no open or ingest
 * call can use it meanwhile). Accounts the session and marks the VM gone; a failed delete is retried by the cron.
 */
export async function destroyWorkspaceSandbox(userId: string, workspaceId: string): Promise<boolean> {
  const [row] = await withUser(userId, (tx) => tx.select().from(sb_).where(eq(sb_.workspaceId, workspaceId)))
  if (!row) return true
  const gone = await destroyVm(row.vercelName, workspaceId)
  await closeSession(userId, workspaceId, row, Math.min(Date.now(), sessionEndEstimate(row)), { status: "stopped", passwordEnc: null, ...leaseCleared, ...(gone ? { vmDeletedAt: new Date() } : {}) })
  return gone
}

/** Files panel (cloud): the running sandbox of a workspace the user owns, and the folder the agent works in. Thrown Responses for route handlers. */
export async function workspaceFiles(userId: string, workspaceId: string): Promise<{ sb: Sandbox; root: string }> {
  const ws = await getWorkspace(userId, workspaceId)
  if (!ws?.sandbox) throw Response.json({ error: "not found" }, { status: 404 })
  let sb: Sandbox
  try {
    sb = await Sandbox.get({ name: ws.sandbox.vercelName, resume: false })
  } catch {
    throw Response.json({ error: "This workspace hasn't started yet." }, { status: 409 })
  }
  if (sb.status !== "running") throw Response.json({ error: "This workspace is asleep. Send a message to wake it." }, { status: 409 })
  return { sb, root: workDir(ws) }
}
