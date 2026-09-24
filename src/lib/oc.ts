"use client"

import { createOpencodeClient } from "@opencode-ai/sdk/client"

/**
 * Typed OpenCode client for the browser.
 * - Local mode: every call goes through the /api/oc proxy (which adds the engine password).
 * - Cloud mode: calls go straight to the workspace's sandbox with the per-start
 *   Basic-auth header from /api/workspaces/:id/open, held in memory only.
 * One client per (base, directory, credentials); the SDK scopes requests to the directory.
 */

export type Connection = { baseUrl: string; headers: Record<string, string> }

const clients = new Map<string, ReturnType<typeof createOpencodeClient>>()

export function oc(directory?: string, conn?: Connection | null) {
  const base = conn?.baseUrl ?? `${window.location.origin}/api/oc`
  const key = `${base}|${directory ?? ""}|${conn?.headers.authorization ?? ""}`
  let c = clients.get(key)
  if (!c) {
    c = createOpencodeClient({ baseUrl: base, directory: directory || undefined, headers: conn?.headers })
    clients.set(key, c)
  }
  return c
}

/** Base URL + headers for raw fetches (SSE, question replies) that bypass the SDK. */
export function ocRaw(conn?: Connection | null): { base: string; headers: Record<string, string> } {
  return { base: conn?.baseUrl ?? "/api/oc", headers: conn?.headers ?? {} }
}

export type * from "@opencode-ai/sdk/client"
