/**
 * State some providers need echoed back on later turns that generic
 * OpenAI-compatible clients (OpenCode's syrup provider included) drop:
 * - Gemini 3 thought signatures on tool calls.
 * - Interleaved reasoning text (reasoning_content) on assistant tool-call
 *   messages for thinking models such as Kimi K3 and DeepSeek.
 * The router remembers both by session and tool-call id and restores them on
 * the way out. Tool-call ids are not unique across chats (Kimi emits
 * "functions.read:0" in every conversation), so every lookup is scoped to the
 * session. Both caches are bounded.
 */

type ToolCall = { id?: string; extra_content?: { google?: { thought_signature?: string } } } & Record<string, unknown>
type Choice = { delta?: { tool_calls?: ToolCall[] }; message?: { tool_calls?: ToolCall[] } }
type AssistantMsg = { role?: string; tool_calls?: ToolCall[] } & Record<string, unknown>

const SIG_SKIP = "skip_thought_signature_validator"

function keyOf(scope: string, id: string): string {
  return `${scope}\u0000${id}`
}

/** Bounded insertion-ordered map. */
class Lru<V> {
  private map = new Map<string, V>()
  private bytes = 0
  constructor(
    private maxEntries: number,
    private maxBytes: number,
    private size: (v: V) => number,
  ) {}
  get(k: string): V | undefined {
    return this.map.get(k)
  }
  set(k: string, v: V) {
    const prev = this.map.get(k)
    if (prev !== undefined) {
      this.bytes -= this.size(prev)
      this.map.delete(k)
    }
    this.map.set(k, v)
    this.bytes += this.size(v)
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.map.keys().next()
      if (first.done) break
      this.bytes -= this.size(this.map.get(first.value) as V)
      this.map.delete(first.value)
    }
  }
  get count() {
    return this.map.size
  }
}

/**
 * Gemini 3 requires each tool call's "thought signature" to be echoed back.
 * Google's OpenAI-compatible API carries it in
 * `tool_calls[].extra_content.google.thought_signature`. For calls the router
 * never saw it uses Google's documented skip value.
 */
export class Signatures {
  private cache = new Lru<string>(5000, 16 * 1024 * 1024, (s) => s.length)

  remember(scope: string, id: string | undefined, sig: string | undefined) {
    if (id && sig) this.cache.set(keyOf(scope, id), sig)
  }

  harvest(scope: string, j: { choices?: Choice[] }) {
    for (const ch of j.choices ?? []) {
      for (const tc of ch.delta?.tool_calls ?? ch.message?.tool_calls ?? []) this.remember(scope, tc.id, tc.extra_content?.google?.thought_signature)
    }
  }

  /** Copy of `messages` with signatures restored on assistant tool calls, plus counts. */
  restore(scope: string, messages: unknown): { messages: unknown; restored: number; skipped: number } {
    let restored = 0
    let skipped = 0
    if (!Array.isArray(messages)) return { messages, restored, skipped }
    const out = messages.map((m: AssistantMsg) => {
      if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) return m
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc) => {
          if (tc.extra_content?.google?.thought_signature) return tc
          const cached = tc.id ? this.cache.get(keyOf(scope, tc.id)) : undefined
          if (cached) restored++
          else skipped++
          return { ...tc, extra_content: { ...tc.extra_content, google: { ...tc.extra_content?.google, thought_signature: cached ?? SIG_SKIP } } }
        }),
      }
    })
    return { messages: out, restored, skipped }
  }
}

/**
 * Thinking models with interleaved reasoning (catalog `interleaved.field`,
 * usually "reasoning_content") reject or degrade on assistant tool-call
 * messages that lost their reasoning. Remember each response's reasoning
 * under its tool-call ids; restore it onto messages that lack the field.
 */
export class InterleavedReasoning {
  private cache = new Lru<string>(2000, 32 * 1024 * 1024, (s) => s.length)

  remember(scope: string, toolCallIds: string[], reasoning: string) {
    if (!reasoning) return
    for (const id of toolCallIds) if (id) this.cache.set(keyOf(scope, id), reasoning)
  }

  /**
   * Copy of `messages` with `field` set on assistant tool-call messages that
   * lack it. Calls the router never saw (another model made them) get an
   * empty string so providers that require the field still accept the turn.
   */
  restore(scope: string, messages: unknown, field: string): { messages: unknown; restored: number; empty: number } {
    let restored = 0
    let empty = 0
    if (!Array.isArray(messages)) return { messages, restored, empty }
    const out = messages.map((m: AssistantMsg) => {
      if (m?.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return m
      if (typeof m[field] === "string" && m[field]) return m
      let text: string | undefined
      for (const tc of m.tool_calls) {
        text = tc.id ? this.cache.get(keyOf(scope, tc.id)) : undefined
        if (text) break
      }
      if (text) restored++
      else empty++
      return { ...m, [field]: text ?? "" }
    })
    return { messages: out, restored, empty }
  }

  get size() {
    return this.cache.count
  }
}
