/**
 * One render at a time (docs/RENDERING.md §2.7): Mermaid keeps global state and temporary DOM, and a long render must
 * not stall typing. Each job starts on idle (500 ms at most) and yields between jobs. A job that runs past its timeout
 * fails at once, but keeps its slot until it settles (or for another timeout at most): a Mermaid render can't be aborted.
 */

export class RenderTimeout extends Error {
  constructor(ms: number) {
    super(`The render took longer than ${Math.round(ms / 1000)} s`)
    this.name = "RenderTimeout"
  }
}

/** A job nobody needs any more by the time its turn comes (its block left the screen): skipped, not run. */
export class RenderDropped extends Error {
  constructor() {
    super("No longer on screen")
    this.name = "RenderDropped"
  }
}

let tail: Promise<void> = Promise.resolve()

function idle(): Promise<void> {
  return new Promise((resolve) => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    if (w.requestIdleCallback) w.requestIdleCallback(() => resolve(), { timeout: 500 })
    else setTimeout(resolve, 1)
  })
}

function yieldToPage(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return s?.yield ? s.yield() : new Promise((r) => setTimeout(r, 0))
}

/**
 * `wanted`: asked when the job's turn comes. False (the reader left the chat, so its blocks unmounted) drops the job at
 * once without starting it, so the chat on screen draws first. A job already running always finishes.
 */
export function schedule<T>(job: (signal: AbortSignal) => Promise<T>, { timeoutMs = 20_000, wanted }: { timeoutMs?: number; wanted?: () => boolean } = {}): Promise<T> {
  let release!: () => void
  const slot = new Promise<void>((r) => (release = r))
  const before = tail
  tail = before.then(() => slot)
  return before.then(async () => {
    if (wanted && !wanted()) {
      release()
      throw new RenderDropped()
    }
    await idle()
    if (wanted && !wanted()) {
      release()
      throw new RenderDropped()
    }
    const ctrl = new AbortController()
    const run = Promise.resolve().then(() => job(ctrl.signal))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new RenderTimeout(timeoutMs))
      }, timeoutMs)
    })
    // The slot frees when the job settles, or a timeout after it timed out at the latest.
    void Promise.race([run.then(() => {}, () => {}), timeout.catch(() => new Promise<void>((r) => setTimeout(r, timeoutMs)))]).finally(() => {
      clearTimeout(timer)
      void yieldToPage().then(release)
    })
    try {
      return await Promise.race([run, timeout])
    } finally {
      clearTimeout(timer)
    }
  })
}
