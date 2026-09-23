"use client"

import { createOpencodeClient } from "@opencode-ai/sdk/client"

/**
 * Typed OpenCode client for the browser. Every call goes through the
 * /api/oc proxy, so the browser never talks to the engine directly.
 */
let client: ReturnType<typeof createOpencodeClient> | undefined

export function oc() {
  if (!client) {
    client = createOpencodeClient({ baseUrl: `${window.location.origin}/api/oc` })
  }
  return client
}

export type * from "@opencode-ai/sdk/client"
