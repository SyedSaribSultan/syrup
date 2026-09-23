import os from "node:os"
import { engine } from "./engine/opencode"
import { env } from "./env"
import { startLedger } from "./ledger"
import { slog } from "./log"

/** Server boot: log the environment, start the engine (which starts the router and MCP), then the ledger. */
export async function boot() {
  if (env.isCloud) {
    // Cloud: no local engine. The agent runs in a sandbox per workspace (Phase 2); Postgres migrates lazily on first use.
    console.log(`[syrup] cloud mode, ${env.appUrl}`)
    return
  }
  slog("boot", "starting", {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpus: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1e9),
    nodeEnv: process.env.NODE_ENV,
    workspace: env.workspace,
    ports: { opencode: env.opencodePort, router: env.routerPort },
    opencodeUrl: env.opencodeUrl ?? null,
    db: env.dbUrl,
    pid: process.pid,
  })

  try {
    const { url } = await engine()
    const health = await fetch(`${url}/global/health`)
      .then((r) => r.json() as Promise<{ version?: string }>)
      .catch(() => undefined)
    slog("boot", "engine.ready", { url, engineVersion: health?.version })
  } catch (err) {
    console.error("[syrup] could not start OpenCode. Is it installed? `npm i -g opencode-ai`", err)
    slog("boot", "engine.failed", err, { level: "error" })
    return
  }
  // Runs in the background for the life of the process.
  void startLedger()
}
