import type http from "node:http"
import { slog } from "./log"
import { deleteMemory, getMemory, listMemories, saveMemory, searchMemories, updateMemory } from "./memory"
import { handleMemoryMcp, type MemoryStore } from "./memory/tools"

/**
 * Local-mode MCP endpoint: the shared memory tools over the SQLite store.
 * Served at /mcp on the router port; OpenCode connects to it as "syrup".
 */

const store: MemoryStore = {
  search: (q, limit) => searchMemories(q, limit),
  list: (limit) => listMemories(limit),
  get: (id) => getMemory(id),
  save: (input) => saveMemory({ ...input, source: "agent" }),
  update: (id, patch) => updateMemory(id, patch),
  delete: (id) => deleteMemory(id),
}

export function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, secret: string) {
  return handleMemoryMcp(req, res, store, slog, secret)
}
