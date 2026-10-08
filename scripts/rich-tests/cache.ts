/** hash and the cache (docs/RENDERING.md §2.7): stable hashes, keys that change with version, theme and width, the LRU cap and single flight. */
import { CACHE_MAX, cacheKey, cacheSize, drop, obtain, peek, type Outcome } from "@/components/rich/cache"
import { RenderDropped, schedule } from "@/components/rich/scheduler"
import { hash } from "@/lib/rich/fence"

type Check = (ok: boolean, label: string, detail?: string) => void

export default async function run(check: Check) {
  check(hash("flowchart TD\nA-->B") === hash("flowchart TD\nA-->B"), "hash is stable")
  check(hash("a") !== hash("b") && hash("ab") !== hash("ba"), "hash tells sources apart")
  check(/^[0-9a-z]+:\d+$/.test(hash("x")) && hash("hello").endsWith(":5"), "hash is base36 plus its length", hash("hello"))
  const k = cacheKey("mermaid", "mermaid@11.17.2/r1", "light", null, hash("A"))
  check(k === `mermaid@mermaid@11.17.2/r1|light|-|${hash("A")}`, "key layout kind@version|scheme|width|hash", k)
  check(k !== cacheKey("mermaid", "mermaid@11.17.2/r2", "light", null, hash("A")), "key changes with the renderer version")
  check(k !== cacheKey("mermaid", "mermaid@11.17.2/r1", "dark", null, hash("A")), "key changes with the theme")
  check(cacheKey("vega-lite", "v", "light", 280, "h") !== cacheKey("vega-lite", "v", "light", 320, "h"), "key changes with the width bucket")

  let runs = 0
  const ready: Outcome = { state: "ready", render: { markup: "<svg/>", width: 1, height: 1, label: "x" }, source: "A", warnings: [] }
  const produce = () => {
    runs++
    return Promise.resolve(ready)
  }
  const a = obtain("one", produce)
  const b = obtain("one", produce)
  await a.promise
  check(a === b && runs === 1, "single flight: two reads, one render")
  check(peek("one") === ready, "peek returns the finished outcome")
  drop("one")
  check(peek("one") === null, "drop forgets it (Retry renders again)")
  for (let i = 0; i < CACHE_MAX + 50; i++) obtain(`k${i}`, produce)
  check(cacheSize() === CACHE_MAX, `the LRU keeps ${CACHE_MAX} entries`, String(cacheSize()))
  check(peek("k0") === null, "the oldest entries go first")

  // Review h7: a render nobody shows any more by its turn is dropped, not run, and the cache forgets it.
  let ran = false
  const dropped = await schedule(
    async () => {
      ran = true
      return 1
    },
    { wanted: () => false },
  ).then(
    () => false,
    (e) => e instanceof RenderDropped,
  )
  check(dropped && !ran, "schedule: a job no longer wanted at its turn is dropped without running")
  const gone = obtain("gone", () => Promise.resolve(null))
  await gone.promise
  check(peek("gone") === null && obtain("gone", produce) !== gone, "obtain: a dropped render leaves no entry, so the next reader renders it again")
}
