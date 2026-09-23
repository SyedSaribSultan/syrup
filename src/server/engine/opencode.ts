import { existsSync } from "node:fs"
import path from "node:path"
import { createOpencodeClient, type Config, type McpLocalConfig, type OpencodeClient } from "@opencode-ai/sdk/client"
import { createOpencodeServer } from "@opencode-ai/sdk/server"
import { env } from "../env"
import { slog } from "../log"
import { ALIASES } from "../router/backends"

export type Engine = {
  /** Base URL of the OpenCode server, e.g. http://127.0.0.1:4096 */
  url: string
  client: OpencodeClient
  close(): void
}

const g = globalThis as unknown as { __syrupEngine?: Promise<Engine> }

/** Full path of an executable on PATH, or null. */
function onPath(name: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase())
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * Optional .sarib MCP server (`pip install "sarib[mcp]"`), registered only when
 * installed. No folder argument: OpenCode runs local MCP servers in the session's
 * directory, so it serves the .sarib files of whichever workspace is open.
 */
function saribMcp(): McpLocalConfig | null {
  const bin = onPath("sarib-mcp")
  slog("engine", bin ? "sarib_mcp.found" : "sarib_mcp.absent", { bin })
  return bin ? { type: "local", command: [bin], enabled: true, timeout: 10_000 } : null
}

/** OpenCode config injected at boot: syrup router as a provider, syrup MCP for memory, memory index as instructions. */
function engineConfig(routerURL: string, memoryIndex: string): Config {
  const sarib = saribMcp()
  const models: NonNullable<NonNullable<Config["provider"]>[string]["models"]> = {}
  for (const [id, a] of Object.entries(ALIASES)) {
    models[id] = {
      name: a.name,
      tool_call: true,
      reasoning: false,
      attachment: false,
      // The router reports real spend in its own ledger; the engine sees $0.
      cost: { input: 0, output: 0 },
      limit: { context: 1_000_000, output: 65_536 },
    }
  }
  return {
    model: "syrup/auto",
    small_model: "syrup/fast",
    instructions: [memoryIndex],
    mcp: {
      syrup: { type: "remote", url: routerURL.replace(/\/v1$/, "/mcp"), enabled: true, timeout: 10_000 },
      ...(sarib ? { sarib } : {}),
    },
    provider: {
      syrup: {
        npm: "@ai-sdk/openai-compatible",
        name: "syrup",
        options: { baseURL: routerURL, apiKey: "syrup", timeout: 600_000 },
        models,
      },
    },
  }
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
      client: createOpencodeClient({ baseUrl: url, directory: env.workspace }),
      close() {},
    }
  }

  const config = engineConfig(routerURL, memoryIndex)
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
    client: createOpencodeClient({ baseUrl: server.url, directory: env.workspace }),
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
