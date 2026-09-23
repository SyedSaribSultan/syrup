"use client"

import { createOpencodeClient } from "@opencode-ai/sdk/client"

/**
 * Typed OpenCode client for the browser. Every call goes through the
 * /api/oc proxy, so the browser never talks to the engine directly.
 * One client per workspace directory: the SDK scopes requests to it.
 */
const clients = new Map<string, ReturnType<typeof createOpencodeClient>>()

export function oc(directory?: string) {
  const key = directory ?? ""
  let c = clients.get(key)
  if (!c) {
    c = createOpencodeClient({ baseUrl: `${window.location.origin}/api/oc`, directory: directory || undefined })
    clients.set(key, c)
  }
  return c
}

export type * from "@opencode-ai/sdk/client"
