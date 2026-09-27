import type { Candidate } from "./backends"

/**
 * Which models each key can actually call, from the provider's own GET /models.
 * The shared catalog lists models a given account may not have (Mistral's free
 * plan has no GLM-5.3 or Large), and routing there costs a failed attempt plus
 * a cooldown. Fails open: an unreadable list, or one that matches none of the
 * catalog's ids, filters nothing.
 */

type Entry = { at: number; ids: Set<string> | null }

export class ServedModels {
  private entries = new Map<string, Entry>()
  private inflight = new Map<string, Promise<void>>()

  constructor(
    private now: () => number,
    private ttlMs = 60 * 60_000,
    private retryMs = 5 * 60_000,
    private firstWaitMs = 1_500,
  ) {}

  /** Candidates whose key serves them. Waits briefly the first time a key is seen, then refreshes in the background. */
  async filter(list: Candidate[]): Promise<{ list: Candidate[]; dropped: number }> {
    const byScope = new Map<string, Candidate[]>()
    for (const c of list) {
      const group = byScope.get(c.keyScope)
      if (group) group.push(c)
      else byScope.set(c.keyScope, [c])
    }
    const keep = new Set<string>()
    await Promise.all(
      [...byScope.values()].map(async (group) => {
        const ids = await this.ids(group[0])
        const served = ids ? group.filter((c) => ids.has(c.upstreamModel) || ids.has(c.modelID)) : group
        for (const c of served.length > 0 ? served : group) keep.add(c.id)
      }),
    )
    const out = list.filter((c) => keep.has(c.id))
    return { list: out, dropped: list.length - out.length }
  }

  snapshot(): Record<string, number | null> {
    return Object.fromEntries([...this.entries].map(([scope, e]) => [scope, e.ids ? e.ids.size : null]))
  }

  private async ids(c: Candidate): Promise<Set<string> | null> {
    const e = this.entries.get(c.keyScope)
    const fresh = e && this.now() - e.at < (e.ids ? this.ttlMs : this.retryMs)
    if (!fresh) {
      let p = this.inflight.get(c.keyScope)
      if (!p) {
        p = this.load(c)
          .then((ids) => void this.entries.set(c.keyScope, { at: this.now(), ids }))
          .finally(() => this.inflight.delete(c.keyScope))
        this.inflight.set(c.keyScope, p)
      }
      if (!e) await Promise.race([p, new Promise((r) => setTimeout(r, this.firstWaitMs))])
    }
    return this.entries.get(c.keyScope)?.ids ?? null
  }

  private async load(c: Candidate): Promise<Set<string> | null> {
    try {
      const res = await fetch(`${c.baseURL}/models`, { headers: { authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return null
      const j = (await res.json()) as { data?: { id?: unknown }[] }
      if (!Array.isArray(j.data)) return null
      const ids = new Set(j.data.map((m) => String(m.id ?? "").replace(/^models\//, "")).filter(Boolean))
      return ids.size > 0 ? ids : null
    } catch {
      return null
    }
  }
}
