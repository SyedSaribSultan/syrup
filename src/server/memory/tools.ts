import type http from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { bearerOk } from "../router/core"
import type { Log } from "../shared/log"

/**
 * The agent's long-term memory tools as an MCP server, over a MemoryStore.
 * Runs in the local server (SQLite store) and inside the sandbox sidecar
 * (HTTP store → /api/ingest). The tool surface is identical in both.
 */

export type MemoryKind = "fact" | "preference" | "project" | "reference" | "note"
export const KINDS: MemoryKind[] = ["fact", "preference", "project", "reference", "note"]

export type MemoryRecord = {
  id: string
  kind: string
  title: string
  content: string
  /** Comma-separated lowercase tags. */
  tags: string
}

export interface MemoryStore {
  search(query: string, limit: number): Promise<MemoryRecord[]>
  list(limit: number): Promise<MemoryRecord[]>
  get(id: string): Promise<MemoryRecord | undefined>
  save(input: { title: string; content: string; kind?: string; tags?: string[] }): Promise<MemoryRecord>
  update(id: string, patch: { title?: string; content?: string; kind?: string; tags?: string[] }): Promise<MemoryRecord | undefined>
  delete(id: string): Promise<void>
}

type Result = { content: { type: "text"; text: string }[] }

function text(s: string): Result {
  return { content: [{ type: "text", text: s }] }
}

const fmt = (r: MemoryRecord) => `[${r.id}] ${r.title} (${r.kind}${r.tags ? `; ${r.tags}` : ""})`

export function buildMemoryServer(store: MemoryStore, log: Log): McpServer {
  const server = new McpServer({ name: "syrup", version: "0.2.0" })

  /** Wraps a tool handler so every call, result size and failure is logged. */
  const logged = <A>(name: string, fn: (args: A) => Promise<Result>) =>
    async (args: A): Promise<Result> => {
      const t0 = Date.now()
      try {
        const out = await fn(args)
        log("mcp", "tool.call", { tool: name, args, ms: Date.now() - t0, resultChars: out.content.reduce((n, c) => n + c.text.length, 0), resultPreview: out.content[0]?.text.slice(0, 300) })
        return out
      } catch (err) {
        log("mcp", "tool.error", { tool: name, args, ms: Date.now() - t0, err }, { level: "error" })
        throw err
      }
    }

  const kindEnum = z.enum(KINDS as [string, ...string[]])

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description: "Search long-term memory (facts, preferences, project notes, references saved in earlier sessions). Returns the best matches with ids.",
      inputSchema: { query: z.string().describe("Keywords or a short phrase"), limit: z.number().int().min(1).max(25).optional().describe("Max results, default 8") },
    },
    logged("memory_search", async ({ query, limit }) => {
      const rows = await store.search(query, limit ?? 8)
      if (rows.length === 0) return text("No memories match.")
      return text(rows.map((r) => `${fmt(r)}\n${r.content}`).join("\n\n"))
    }),
  )

  server.registerTool(
    "memory_list",
    { title: "List recent memories", description: "List the most recently updated memories.", inputSchema: { limit: z.number().int().min(1).max(100).optional() } },
    logged("memory_list", async ({ limit }) => {
      const rows = await store.list(limit ?? 20)
      if (rows.length === 0) return text("No memories saved yet.")
      return text(rows.map((r) => `${fmt(r)} — ${r.content.slice(0, 200)}`).join("\n"))
    }),
  )

  server.registerTool(
    "memory_get",
    { title: "Get a memory", description: "Read one memory in full by id.", inputSchema: { id: z.string() } },
    logged("memory_get", async ({ id }) => {
      const m = await store.get(id)
      return text(m ? `${fmt(m)}\n${m.content}` : "Not found.")
    }),
  )

  server.registerTool(
    "memory_save",
    {
      title: "Save a memory",
      description: "Save one fact to long-term memory so it is available in future sessions. Use for user preferences, project decisions, conventions, and external references. One fact per memory, with a clear title.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Short, specific title"),
        content: z.string().min(1).describe("The fact itself, plus why it matters if not obvious"),
        kind: kindEnum.optional().describe("fact | preference | project | reference | note"),
        tags: z.array(z.string()).optional().describe("Lowercase tags for retrieval"),
      },
    },
    logged("memory_save", async ({ title, content, kind, tags }) => {
      const m = await store.save({ title, content, kind, tags })
      return text(`Saved memory ${m.id}: ${m.title}`)
    }),
  )

  server.registerTool(
    "memory_update",
    {
      title: "Update a memory",
      description: "Correct or extend an existing memory.",
      inputSchema: { id: z.string(), title: z.string().min(1).max(200).optional(), content: z.string().min(1).optional(), kind: kindEnum.optional(), tags: z.array(z.string()).optional() },
    },
    logged("memory_update", async ({ id, ...patch }) => {
      const m = await store.update(id, patch)
      return text(m ? `Updated ${m.id}: ${m.title}` : "Not found.")
    }),
  )

  server.registerTool(
    "memory_forget",
    { title: "Forget a memory", description: "Delete a memory that is wrong or no longer relevant.", inputSchema: { id: z.string() } },
    logged("memory_forget", async ({ id }) => {
      await store.delete(id)
      return text(`Forgot ${id}.`)
    }),
  )

  return server
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let s = ""
  for await (const chunk of req) s += chunk
  return s ? JSON.parse(s) : undefined
}

function reply(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

/** Stateless Streamable HTTP MCP endpoint: bearer-guarded, one server + transport per request. */
export async function handleMemoryMcp(req: http.IncomingMessage, res: http.ServerResponse, store: MemoryStore, log: Log, secret: string) {
  if (!bearerOk(req, secret)) {
    log("mcp", "request.unauthorized", {}, { level: "warn" })
    return reply(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null })
  }
  if (req.method !== "POST") return reply(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { allow: "POST" })
  let body: unknown
  try {
    body = await readJson(req)
  } catch {
    log("mcp", "request.bad_json", {}, { level: "warn" })
    return reply(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null })
  }
  const method = (body as { method?: string })?.method
  if (method && method !== "tools/call") log("mcp", "request", { method }, { level: "debug" })
  const server = buildMemoryServer(store, log)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on("close", () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
