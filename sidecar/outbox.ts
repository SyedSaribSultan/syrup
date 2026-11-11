import type { Log } from "../src/server/shared/log"

/** A write to the syrup app that failed with this HTTP status (ingest() in store-http.ts). */
export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * Refusals that will not change on a retry: the token is no longer accepted (the sandbox session ended, the account was
 * blocked) or the app rejects the body itself. Timeouts, rate limits, 5xx and network errors are retried.
 */
export function finalFailure(err: unknown): boolean {
  return err instanceof IngestError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429
}

export type OutboxOptions<T> = {
  /** Sends one batch; throws to fail it. */
  send: (batch: T[]) => Promise<unknown>
  log: Log
  /** Log event names: `${name}.retry` and `${name}.dropped`. */
  name: string
  maxBatch: number
  /** Oldest items are dropped past this, so a long outage cannot grow memory without bound. */
  maxQueue: number
  /** Wait this long after the first item for others to join its batch. */
  batchMs: number
  /** First retry delay; doubles per failure up to 30 s. */
  retryMs: number
}

/**
 * In-order delivery of the sidecar's writes to the app: one batch in flight at a time, a failed batch goes back to the
 * front and is retried with backoff, a final refusal (finalFailure) drops it with a log. Lives in memory: a VM killed
 * without SIGTERM loses what is queued, which the event tap's resync on the next start makes up for.
 */
export class Outbox<T> {
  private queue: T[] = []
  private timer: NodeJS.Timeout | undefined
  private sending: Promise<void> | null = null
  private failures = 0

  constructor(private o: OutboxOptions<T>) {}

  get size() {
    return this.queue.length
  }

  push(...items: T[]) {
    this.queue.push(...items)
    const over = this.queue.length - this.o.maxQueue
    if (over > 0) {
      this.queue.splice(0, over)
      this.o.log("sidecar", `${this.o.name}.dropped`, { n: over, why: "queue full" }, { level: "warn" })
    }
    if (this.queue.length >= this.o.maxBatch) this.kick(0)
    else this.kick(this.o.batchMs)
  }

  private kick(ms: number) {
    if (this.sending) return
    // A pending timer is either the batch window or a retry backoff; neither is cut short by more items.
    if (this.timer && (ms > 0 || this.failures > 0)) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, ms)
    this.timer.unref?.()
  }

  /** Sends batches until the queue is empty or one fails. Concurrent callers share the run in flight. */
  private drain(): Promise<void> {
    this.sending ??= this.run().finally(() => {
      this.sending = null
      // Items pushed after the last batch went out, while this run was settling.
      if (this.queue.length && !this.timer) this.kick(this.o.batchMs)
    })
    return this.sending
  }

  private async run(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.o.maxBatch)
      try {
        await this.o.send(batch)
        this.failures = 0
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (finalFailure(err)) {
          this.o.log("sidecar", `${this.o.name}.dropped`, { n: batch.length, message }, { level: "warn" })
          continue
        }
        this.queue.unshift(...batch)
        this.failures++
        const wait = Math.min(30_000, this.o.retryMs * 2 ** (this.failures - 1))
        this.o.log("sidecar", `${this.o.name}.retry`, { n: batch.length, inMs: wait, message }, { level: "warn" })
        this.timer = setTimeout(() => {
          this.timer = undefined
          void this.drain()
        }, wait)
        this.timer.unref?.()
        return
      }
    }
  }

  /** Before exit: one pass over everything queued, without waiting for a backoff. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.sending
    await this.drain()
  }
}
