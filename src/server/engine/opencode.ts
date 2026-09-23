import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import { createOpencodeServer } from "@opencode-ai/sdk/server"
import { env } from "../env"

export type Engine = {
  /** Base URL of the OpenCode server, e.g. http://127.0.0.1:4096 */
  url: string
  client: OpencodeClient
  close(): void
}

const g = globalThis as unknown as { __syrupEngine?: Promise<Engine> }

async function start(): Promise<Engine> {
  if (env.opencodeUrl) {
    const url = env.opencodeUrl.replace(/\/$/, "")
    return {
      url,
      client: createOpencodeClient({ baseUrl: url, directory: env.workspace }),
      close() {},
    }
  }

  const server = await createOpencodeServer({
    hostname: env.opencodeHostname,
    port: env.opencodePort,
    timeout: 20_000,
  })
  console.log(`[syrup] opencode server at ${server.url} (workspace ${env.workspace})`)
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
