import type http from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { deleteMemory, getMemory, KINDS, listMemories, saveMemory, searchMemories, updateMemory } from "./memory"

/**
 * syrup's MCP server. Exposes long-term memory to the agent as tools.
 * Served over Streamable HTTP at /mcp on the router port; OpenCode connects
 * to it as the remote MCP server "syrup".
 */

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "syrup", version: "0.1.0" })

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description: "Search long-term memory (facts, preferences, project notes, references saved in earlier sessions). Returns the best matches with ids.",
      inputSchema: {
        query: z.string().describe("Keywords or a short phrase"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results, default 8"),
      },
    },
    async ({ query, limit }) => {
      const rows = await searchMemories(query, limit ?? 8)
      if (rows.length === 0) return text("No memories match.")
      return text(rows.map((r) => `[${r.id}] ${r.title} (${r.kind}${r.tags ? `; ${r.tags}` : ""})\n${r.content}`).join("\n\n"))
    },
  )

  server.registerTool(
    "memory_list",
    {
      title: "List recent memories",
      description: "List the most recently updated memories.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit }) => {
      const rows = await listMemories(limit ?? 20)
      if (rows.length === 0) return text("No memories saved yet.")
      return text(rows.map((r) => `[${r.id}] ${r.title} (${r.kind}${r.tags ? `; ${r.tags}` : ""}) — ${r.content.slice(0, 200)}`).join("\n"))
    },
  )

  server.registerTool(
    "memory_get",
    { title: "Get a memory", description: "Read one memory in full by id.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const m = await getMemory(id)
      return text(m ? `[${m.id}] ${m.title} (${m.kind}${m.tags ? `; ${m.tags}` : ""})\n${m.content}` : "Not found.")
    },
  )

  server.registerTool(
    "memory_save",
    {
      title: "Save a memory",
      description:
        "Save one fact to long-term memory so it is available in future sessions. Use for user preferences, project decisions, conventions, and external references. One fact per memory, with a clear title.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Short, specific title"),
        content: z.string().min(1).describe("The fact itself, plus why it matters if not obvious"),
        kind: z.enum(KINDS as [string, ...string[]]).optional().describe("fact | preference | project | reference | note"),
        tags: z.array(z.string()).optional().describe("Lowercase tags for retrieval"),
      },
    },
    async ({ title, content, kind, tags }) => {
      const m = await saveMemory({ title, content, kind, tags, source: "agent" })
      return text(`Saved memory ${m.id}: ${m.title}`)
    },
  )

  server.registerTool(
    "memory_update",
    {
      title: "Update a memory",
      description: "Correct or extend an existing memory.",
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).optional(),
        kind: z.enum(KINDS as [string, ...string[]]).optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ id, ...patch }) => {
      const m = await updateMemory(id, patch)
      return text(m ? `Updated ${m.id}: ${m.title}` : "Not found.")
    },
  )

  server.registerTool(
    "memory_forget",
    { title: "Forget a memory", description: "Delete a memory that is wrong or no longer relevant.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      await deleteMemory(id)
      return text(`Forgot ${id}.`)
    },
  )

  return server
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let s = ""
  for await (const chunk of req) s += chunk
  return s ? JSON.parse(s) : undefined
}

/** Stateless Streamable HTTP: one server + transport per request. */
export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" })
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }))
    return
  }
  let body: unknown
  try {
    body = await readJson(req)
  } catch {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }))
    return
  }
  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on("close", () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
