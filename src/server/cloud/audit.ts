import { ulid } from "ulid"
import { pg, pgReady, pgSchema, type PgTx } from "../db/pg"

type Entry = {
  userId?: string | null
  actor: "user" | "system" | "admin"
  action: string
  target?: string | null
  data?: unknown
  ipHash?: string | null
}

/** Append one audit row. Pass the transaction when inside withUser(); otherwise it uses its own connection. */
export async function audit(tx: PgTx | null, e: Entry): Promise<void> {
  const row = { id: ulid(), userId: e.userId ?? null, actor: e.actor, action: e.action, target: e.target ?? null, data: e.data ?? null, ipHash: e.ipHash ?? null }
  if (tx) {
    await tx.insert(pgSchema.auditLog).values(row)
  } else {
    await pgReady()
    await pg().insert(pgSchema.auditLog).values(row)
  }
}
