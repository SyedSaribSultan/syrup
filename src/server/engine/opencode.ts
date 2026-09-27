import { createOpencodeClient, type Config, type OpencodeClient } from "@opencode-ai/sdk/client"
import { createOpencodeServer } from "@opencode-ai/sdk/server"
import { env } from "../env"
import { slog } from "../log"
import { ALIASES } from "../router/backends"
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

type AgentPrompts = { agent?: Record<string, { prompt?: string }> }

/** Config syrup hands to OpenCode: the SDK type plus the keys it lacks. */
export type EngineConfig = Config & CompactionConfig & AgentPrompts

/** The "syrup" provider (router), memory MCP and token-saving settings, shared by local mode and the sandbox sidecar config. */
export function syrupEngineConfig(routerURL: string, secret: string): Pick<Config, "model" | "small_model" | "mcp" | "provider"> & CompactionConfig & AgentPrompts {
  const models: NonNullable<NonNullable<Config["provider"]>[string]["models"]> = {}
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
      // 32K output matches what OpenCode asks for per request anyway.
      limit: { context: 256_000, output: 32_000 },
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
  }
}

/** OpenCode config injected at boot (local mode): router provider, memory MCP, memory index as instructions. */
function engineConfig(routerURL: string, memoryIndex: string): EngineConfig {
  return { ...syrupEngineConfig(routerURL, env.internalSecret), instructions: [memoryIndex] }
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
  return {
    url: server.url,
    client: createOpencodeClient({ baseUrl: server.url, directory: env.workspace, headers: { authorization: engineAuthHeader() } }),
    close: () => server.close(),
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
