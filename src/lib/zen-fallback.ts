import { isFree, modelInfo, usableForAgent, type ModelLike } from "./model-registry"

/**
 * Auto and Fast without a routable key: the turn goes straight to OpenCode Zen's free models.
 *
 * The router cannot hold Zen as a candidate: Zen's free tier answers 403 "can only be used from within OpenCode" to
 * proxied requests (see BASE_URL in server/router/backends.ts). OpenCode calling Zen itself is allowed, so the app
 * resolves the alias before sending and names the Zen model directly. With a routable key the router keeps the alias.
 *
 * Ranked with the same table the router uses (model-registry): Auto takes the best quality, Fast the quickest model
 * that is still capable (mid grade or better, when one exists).
 */
const FAST_MIN_QUALITY = 55
/** Tokens a typical reply streams, to weigh decode speed against time to first token. */
const TYPICAL_REPLY_TOKENS = 400

export type ZenAlias = "auto" | "fast"

export function isZenAlias(modelID: string | undefined): modelID is ZenAlias {
  return modelID === "auto" || modelID === "fast"
}

/** Zen model ids in the order the alias would try them, best first. Empty when Zen offers nothing usable. */
export function zenRanking(alias: ZenAlias, zen: ModelLike[]): string[] {
  const usable = zen.filter((m) => usableForAgent(m) && isFree(m))
  const info = new Map(usable.map((m) => [m.id, modelInfo("opencode", m)]))
  const q = (m: ModelLike) => info.get(m.id)!.quality
  const time = (m: ModelLike) => {
    const i = info.get(m.id)!
    return i.ttftMs + (TYPICAL_REPLY_TOKENS / Math.max(i.tps, 1)) * 1000
  }
  if (alias === "fast") {
    const capable = usable.filter((m) => q(m) >= FAST_MIN_QUALITY)
    const pool = capable.length ? capable : usable
    return [...pool].sort((a, b) => time(a) - time(b) || q(b) - q(a)).map((m) => m.id)
  }
  return [...usable].sort((a, b) => q(b) - q(a) || time(a) - time(b)).map((m) => m.id)
}
