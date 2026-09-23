import path from "node:path"

function int(v: string | undefined, fallback: number) {
  const n = v ? Number.parseInt(v, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

export const env = {
  /** If set, syrup connects to an already-running OpenCode server instead of spawning one. */
  opencodeUrl: process.env.OPENCODE_URL || undefined,
  opencodePort: int(process.env.OPENCODE_PORT, 4096),
  opencodeHostname: process.env.OPENCODE_HOSTNAME || "127.0.0.1",
  /** Directory the agent works in. */
  workspace: path.resolve(process.env.SYRUP_WORKSPACE || process.cwd()),
  /** Port for the in-process OpenAI-compatible router the engine calls. */
  routerPort: int(process.env.SYRUP_ROUTER_PORT, 4210),
  dbUrl: process.env.SYRUP_DB || "file:./data/syrup.db",
  vaultKey: process.env.SYRUP_VAULT_KEY || undefined,
}
