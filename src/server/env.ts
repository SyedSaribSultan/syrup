import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"

function int(v: string | undefined, fallback: number) {
  const n = v ? Number.parseInt(v, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Mode decides the whole shape of the app:
 * - local: one user, one machine, the agent runs here (OpenCode spawned by syrup), SQLite, no login.
 * - cloud: many users behind Google sign-in, Postgres, the agent runs in a sandbox per workspace.
 * SYRUP_MODE wins; otherwise a Vercel deployment is cloud and everything else is local.
 */
export type Mode = "local" | "cloud"
const mode: Mode = process.env.SYRUP_MODE === "cloud" || process.env.SYRUP_MODE === "local" ? process.env.SYRUP_MODE : process.env.VERCEL ? "cloud" : "local"

/**
 * Per-process secret shared between syrup and the processes it spawns
 * (OpenCode server password, router bearer). Never persisted; a restart
 * makes a new one and restarts the children with it.
 */
const g = globalThis as unknown as { __syrupInternalSecret?: string }
const internalSecret = (g.__syrupInternalSecret ??= crypto.randomBytes(24).toString("base64url"))

/** Where local-mode secrets live: outside any plausible workspace, so the agent cannot read them. */
function configDir(): string {
  if (process.env.SYRUP_HOME) return path.resolve(process.env.SYRUP_HOME)
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "syrup")
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "syrup")
}

export const env = {
  mode,
  isCloud: mode === "cloud",
  /** If set, syrup connects to an already-running OpenCode server instead of spawning one. */
  opencodeUrl: process.env.OPENCODE_URL || undefined,
  opencodePort: int(process.env.OPENCODE_PORT, 4096),
  opencodeHostname: process.env.OPENCODE_HOSTNAME || "127.0.0.1",
  /** Directory the agent works in (local mode). */
  workspace: path.resolve(process.env.SYRUP_WORKSPACE || process.cwd()),
  /** Port for the in-process OpenAI-compatible router the engine calls. */
  routerPort: int(process.env.SYRUP_ROUTER_PORT, 4210),
  dbUrl: process.env.SYRUP_DB || "file:./data/syrup.db",
  /** Local vault master key override (base64, 32 bytes). Normally generated into configDir. */
  vaultKey: process.env.SYRUP_VAULT_KEY || undefined,
  configDir: configDir(),
  internalSecret,

  // Cloud
  /** Wraps every user's data-encryption key. Required in cloud mode. */
  masterKey: process.env.SYRUP_MASTER_KEY || undefined,
  databaseUrl: process.env.DATABASE_URL || undefined,
  databaseUrlUnpooled: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || undefined,
  adminEmails: list(process.env.SYRUP_ADMIN_EMAILS),
  /** Seed invites until the admin page manages them. */
  invites: list(process.env.SYRUP_INVITES),
  appUrl: process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"),
  posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY || undefined,
  /** Bearer that lets CLI smoke tests act as the first admin (see cloud/session.ts). */
  opsToken: process.env.SYRUP_OPS_TOKEN || undefined,
  posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com",
}
