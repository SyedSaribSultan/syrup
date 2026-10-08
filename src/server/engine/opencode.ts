import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient, type Config, type OpencodeClient } from "@opencode-ai/sdk/client"
import { createOpencodeServer } from "@opencode-ai/sdk/server"
import { env } from "../env"
import { slog } from "../log"
import { ALIASES } from "../router/backends"
import { EVAL_HEADER } from "../router/policy"
import { SYRUP_PROMPT } from "./prompt"

export type Engine = {
  /** Base URL of the OpenCode server, e.g. http://127.0.0.1:4096 */
  url: string
  client: OpencodeClient
  close(): void
}

const g = globalThis as unknown as { __syrupEngine?: Promise<Engine> }

/** Basic-auth header the OpenCode server expects once OPENCODE_SERVER_PASSWORD is set. */
export function engineAuthHeader(): string {
  return `Basic ${Buffer.from(`opencode:${env.internalSecret}`).toString("base64")}`
}

/**
 * Config keys OpenCode 1.18 accepts that the v1 SDK Config type does not
 * declare yet. compaction.prune masks old tool outputs before a turn is sent
 * (off by default in OpenCode); compaction.auto summarises when the context
 * fills up.
 */
type CompactionConfig = { compaction?: { auto?: boolean; prune?: boolean } }

/**
 * A provider model as OpenCode 1.18 reads it: the v1 SDK type lacks limit.input. Set, it moves
 * auto-compaction from context − output (224K for the aliases) to input − 20K (session/overflow.ts).
 */
type ProviderModel = NonNullable<NonNullable<Config["provider"]>[string]["models"]>[string]
type AliasModel = ProviderModel & { limit: { context: number; input?: number; output: number } }

type AgentPrompts = { agent?: Record<string, { prompt?: string }> }

/** Config syrup hands to OpenCode: the SDK type plus the keys it lacks. */
export type EngineConfig = Config & CompactionConfig & AgentPrompts

export type EngineConfigOptions = {
  /** syrup's OpenCode plugin as a file:// URL (engine/syrup-plugin.ts, built to .sidecar/syrup-plugin.js). */
  plugin?: string
  /** An eval engine (`pnpm eval`): every model request carries EVAL_HEADER, so eval traffic never spends scarce quota. */
  eval?: boolean
}

/** The "syrup" provider (router), memory MCP, syrup's plugin and token-saving settings, shared by local mode and the sandbox sidecar config. */
export function syrupEngineConfig(routerURL: string, secret: string, opts: EngineConfigOptions = {}): Pick<Config, "model" | "small_model" | "mcp" | "provider" | "plugin"> & CompactionConfig & AgentPrompts {
  const models: Record<string, AliasModel> = {}
  for (const [id, a] of Object.entries(ALIASES)) {
    models[id] = {
      name: a.name,
      tool_call: true,
      reasoning: false,
      attachment: false,
      // The router reports real spend in its own ledger; the engine sees $0.
      cost: { input: 0, output: 0 },
      // 256K keeps prompts within reach of the strong free models, which mostly
      // have 200K–1M windows, and makes OpenCode compact before prompts get slow.
      // 32K output matches what OpenCode asks for per request anyway. 120K input makes auto-compaction
      // fire at ~100K (120K − 20K reserved) instead of 224K: a backstop for long chats, measured in the
      // Q0 spike (docs/QUALITY.md Q2); the plugin's trimming and masking keep ordinary chats far below it.
      limit: { context: 256_000, input: 120_000, output: 32_000 },
      ...(opts.eval ? { headers: { [EVAL_HEADER]: "1" } } : {}),
    }
  }
  return {
    model: "syrup/auto",
    small_model: "syrup/fast",
    // Pruning old tool outputs is roughly half the tokens of keeping them, with
    // equal or better solve rates; auto keeps summarising when the window fills.
    compaction: { auto: true, prune: true },
    // syrup's identity and voice instead of OpenCode's "You are opencode" base prompt.
    agent: { build: { prompt: SYRUP_PROMPT }, plan: { prompt: SYRUP_PROMPT } },
    mcp: {
      syrup: { type: "remote", url: routerURL.replace(/\/v1$/, "/mcp"), enabled: true, timeout: 10_000, headers: { authorization: `Bearer ${secret}` } },
    },
    provider: {
      syrup: {
        npm: "@ai-sdk/openai-compatible",
        name: "syrup",
        options: { baseURL: routerURL, apiKey: secret, timeout: 600_000 },
        models,
      },
    },
    ...(opts.plugin ? { plugin: [opts.plugin] } : {}),
  }
}

/** The built plugin for local mode, or undefined (with a warning) when `.sidecar/` wasn't built: `pnpm dev` and `pnpm build` build it. */
function localPlugin(): string | undefined {
  const file = path.join(process.cwd(), ".sidecar", "syrup-plugin.js")
  if (fs.existsSync(file)) return pathToFileURL(file).href
  slog("engine", "plugin.missing", { file, fix: "node sidecar/build.mjs" }, { level: "warn" })
  return undefined
}

/** OpenCode config injected at boot (local mode): router provider, memory MCP, memory index as instructions. */
function engineConfig(routerURL: string, memoryIndex: string): EngineConfig {
  return { ...syrupEngineConfig(routerURL, env.internalSecret, { plugin: localPlugin(), eval: process.env.SYRUP_EVAL === "1" }), instructions: [memoryIndex] }
}

async function start(): Promise<Engine> {
  const { startRouter } = await import("../router/server")
  const { writeIndex } = await import("../memory")
  const [routerURL, memoryIndex] = await Promise.all([startRouter(), writeIndex()])

  if (env.opencodeUrl) {
    const url = env.opencodeUrl.replace(/\/$/, "")
    slog("engine", "attached", { url, workspace: env.workspace })
    return {
      url,
      client: createOpencodeClient({ baseUrl: url, directory: env.workspace, headers: process.env.OPENCODE_SERVER_PASSWORD ? { authorization: engineAuthHeader() } : undefined }),
      close() {},
    }
  }

  const config = engineConfig(routerURL, memoryIndex)
  // Loading a plugin makes OpenCode install @opencode-ai/plugin into each config dir without node_modules before a
  // workspace's first request (~21 s once). The eval engine's dirs are its own, so they are prepared (config-dirs.ts).
  // The user's real ~/.config/opencode is never seeded: an empty seed looks installed, so a tool or plugin the user adds
  // there later could not find @opencode-ai/plugin. Instead the one real install runs in the background right after
  // spawn (warmEngine below), long before anyone types.
  const evalEngine = process.env.SYRUP_EVAL === "1"
  if (config.plugin?.length && evalEngine) {
    const { localConfigDirs, prepareConfigDirs } = await import("./config-dirs")
    const dirs = prepareConfigDirs(localConfigDirs())
    slog("engine", "config_dirs", { dirs: dirs.map((d) => ({ dir: d.dir, action: d.action, reason: d.reason, ...(d.error && { error: d.error }) })) })
  }
  // Every request to the engine must carry this password; the SDK passes process.env to the child.
  process.env.OPENCODE_SERVER_PASSWORD = env.internalSecret
  // Skill on/off switches live in a file the engine re-reads on every instance reload, so toggles apply without a respawn.
  try {
    const { writeSkillConfig } = await import("../skills")
    process.env.OPENCODE_CONFIG = await writeSkillConfig()
  } catch (err) {
    slog("engine", "skills.config_failed", { err }, { level: "warn" })
  }
  // ~/.claude/CLAUDE.md holds the user's instructions for Claude Code, not for syrup's agent.
  process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1"
  // Web search (Exa's free public endpoint); off by default in OpenCode, so the agent could only fetch known URLs.
  process.env.OPENCODE_ENABLE_EXA = "1"
  const t0 = Date.now()
  let server: Awaited<ReturnType<typeof createOpencodeServer>>
  try {
    server = await createOpencodeServer({ hostname: env.opencodeHostname, port: env.opencodePort, timeout: 20_000, config })
  } catch (err) {
    slog("engine", "spawn.failed", { err, port: env.opencodePort }, { level: "error" })
    throw err
  }
  console.log(`[syrup] opencode server at ${server.url} (workspace ${env.workspace})`)
  slog("engine", "spawned", { url: server.url, workspace: env.workspace, ms: Date.now() - t0, config })
  if (config.plugin?.length && !evalEngine) warmEngine(server.url)
  return {
    url: server.url,
    client: createOpencodeClient({ baseUrl: server.url, directory: env.workspace, headers: { authorization: engineAuthHeader() } }),
    close: () => server.close(),
  }
}

/**
 * Boots the instance of the Home workspace (~/syrup) and of the launch folder in the background, so OpenCode's one-time
 * install of @opencode-ai/plugin into an unprepared config dir (~21 s) happens before the first message, not during it.
 * Fire and forget: a failure only means that first message waits as it would have anyway.
 */
function warmEngine(url: string) {
  const headers = { authorization: engineAuthHeader() }
  const t0 = Date.now()
  for (const dir of new Set([path.join(os.homedir(), "syrup"), env.workspace])) {
    void fetch(`${url}/path?directory=${encodeURIComponent(dir)}`, { headers, signal: AbortSignal.timeout(120_000) })
      .then((r) => slog("engine", "warm", { dir, status: r.status, ms: Date.now() - t0 }))
      .catch((err) => slog("engine", "warm.failed", { dir, err }, { level: "warn" }))
  }
}

/** Returns the running engine, starting it on first call. Survives Next.js HMR. */
export function engine(): Promise<Engine> {
  if (!g.__syrupEngine) {
    g.__syrupEngine = start().catch((err) => {
      g.__syrupEngine = undefined
      throw err
    })
  }
  return g.__syrupEngine
}
