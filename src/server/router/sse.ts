/**
 * Minimal server-sent-events reading for OpenAI-compatible chat streams:
 * split chunks into lines, tell keep-alives and role-only deltas apart from
 * the first meaningful event (the router's commit point), and tap usage,
 * Gemini signatures and interleaved reasoning as the stream passes through.
 */

export type Usage = { prompt_tokens?: number; completion_tokens?: number }

export type SseLine = { kind: "comment" } | { kind: "done" } | { kind: "data"; json: unknown } | { kind: "junk" }

export class SseScanner {
  private dec = new TextDecoder()
  private buf = ""

  push(chunk: Uint8Array): SseLine[] {
    this.buf += this.dec.decode(chunk, { stream: true })
    const out: SseLine[] = []
    let idx: number
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "")
      this.buf = this.buf.slice(idx + 1)
      const parsed = parseLine(line)
      if (parsed) out.push(parsed)
    }
    // A provider that never sends newlines should not grow the buffer without bound.
    if (this.buf.length > 4 * 1024 * 1024) this.buf = ""
    return out
  }

  /** Whatever is left when the stream ends without a trailing newline. */
  flush(): SseLine[] {
    const rest = this.buf + this.dec.decode()
    this.buf = ""
    const parsed = parseLine(rest.replace(/\r$/, ""))
    return parsed ? [parsed] : []
  }
}

function parseLine(line: string): SseLine | null {
  if (!line) return null
  if (line.startsWith(":")) return { kind: "comment" }
  if (!line.startsWith("data:")) return null
  const data = line.slice(5).trim()
  if (!data) return null
  if (data === "[DONE]") return { kind: "done" }
  try {
    return { kind: "data", json: JSON.parse(data) }
  } catch {
    return { kind: "junk" }
  }
}

type Delta = { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown } & Record<string, unknown>
type Chunk = { error?: unknown; usage?: Usage | null; choices?: { delta?: Delta; message?: Delta; finish_reason?: string | null }[] }

function filled(v: unknown): boolean {
  if (typeof v === "string") return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  return false
}

/**
 * "content" once a chunk carries something the client can use (text,
 * reasoning, tool calls); "end" for a finish reason or usage with none of
 * that (an answer that ends before any content is an empty answer, not a
 * commit); "error" for an error object inside the stream; null for role-only
 * deltas and other empty chunks.
 */
export function chunkKind(j: unknown): "content" | "end" | "error" | null {
  if (!j || typeof j !== "object") return null
  const c = j as Chunk
  if (c.error) return "error"
  let end = !!c.usage
  for (const ch of c.choices ?? []) {
    const d = ch.delta ?? ch.message
    if (d && (filled(d.content) || filled(d.reasoning_content) || filled(d.reasoning) || filled(d.reasoning_details) || filled(d.tool_calls))) return "content"
    if (ch.finish_reason) end = true
  }
  return end ? "end" : null
}

const MAX_REASONING = 400_000

/** Collects what the router needs from a response while it streams to the client. */
export class StreamTap {
  usage: Usage = {}
  reasoning = ""
  toolCallIds: string[] = []
  finishReason: string | null = null

  constructor(
    /** Receives every chunk for Gemini thought-signature harvesting. */
    private harvest: ((chunk: unknown) => void) | null,
    private field: string | null,
  ) {}

  observe(j: unknown) {
    if (!j || typeof j !== "object") return
    const c = j as Chunk
    if (c.usage && (c.usage.prompt_tokens || c.usage.completion_tokens)) this.usage = c.usage
    this.harvest?.(c)
    for (const ch of c.choices ?? []) {
      if (ch.finish_reason) this.finishReason = ch.finish_reason
      const d = ch.delta ?? ch.message
      if (!d) continue
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls as { id?: unknown }[]) if (typeof tc?.id === "string" && tc.id && !this.toolCallIds.includes(tc.id)) this.toolCallIds.push(tc.id)
      }
      if (this.field && this.reasoning.length < MAX_REASONING) {
        const r = d[this.field] ?? d.reasoning_content ?? d.reasoning
        if (typeof r === "string") this.reasoning += r
      }
    }
  }
}
