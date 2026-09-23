import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { and, desc, eq, isNull } from "drizzle-orm"
import { ulid } from "ulid"
import { pg, pgReady, pgSchema, withUser } from "../db/pg"
import { audit } from "./audit"

/**
 * Legal documents and consent records (docs/PLAN.md §6).
 * Documents are markdown files in src/content/legal, versioned by date. Each
 * (kind, version) gets one row in legal_documents; consents point at it, so
 * we always know which text a person agreed to.
 */

export type LegalKind = "terms" | "privacy" | "research" | "cookies"

export const LEGAL: Record<LegalKind, { title: string; version: string; file: string }> = {
  terms: { title: "Terms of Service", version: "2026-09-23", file: "terms.md" },
  privacy: { title: "Privacy Policy", version: "2026-09-23", file: "privacy.md" },
  research: { title: "Research Data Consent", version: "2026-09-23", file: "research.md" },
  cookies: { title: "Cookie Notice", version: "2026-09-23", file: "cookies.md" },
}

const dir = path.join(process.cwd(), "src", "content", "legal")

export function readLegal(kind: LegalKind): { title: string; version: string; markdown: string } {
  const doc = LEGAL[kind]
  return { title: doc.title, version: doc.version, markdown: fs.readFileSync(path.join(dir, doc.file), "utf8") }
}

/** Row id for the current version of a document, inserting it on first use. */
export async function legalDocId(kind: LegalKind): Promise<string> {
  await pgReady()
  const db = pg()
  const doc = LEGAL[kind]
  const [row] = await db.select({ id: pgSchema.legalDocuments.id }).from(pgSchema.legalDocuments).where(and(eq(pgSchema.legalDocuments.kind, kind), eq(pgSchema.legalDocuments.version, doc.version)))
  if (row) return row.id
  const hash = crypto.createHash("sha256").update(readLegal(kind).markdown).digest("hex")
  const id = ulid()
  await db.insert(pgSchema.legalDocuments).values({ id, kind, version: doc.version, contentHash: hash }).onConflictDoNothing()
  const [again] = await db.select({ id: pgSchema.legalDocuments.id }).from(pgSchema.legalDocuments).where(and(eq(pgSchema.legalDocuments.kind, kind), eq(pgSchema.legalDocuments.version, doc.version)))
  return again?.id ?? id
}

export async function recordConsent(userId: string, kinds: LegalKind[], meta: { ipHash: string | null; userAgent: string | null }): Promise<void> {
  const ids = Object.fromEntries(await Promise.all(kinds.map(async (k) => [k, await legalDocId(k)] as const)))
  await withUser(userId, async (tx) => {
    for (const kind of kinds) {
      await tx.insert(pgSchema.consents).values({ id: ulid(), userId, kind, legalDocumentId: ids[kind], ipHash: meta.ipHash, userAgent: meta.userAgent })
    }
    await audit(tx, { userId, actor: "user", action: "consent.grant", data: { kinds }, ipHash: meta.ipHash })
  })
}

export async function revokeConsent(userId: string, kind: LegalKind, meta: { ipHash: string | null }): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.update(pgSchema.consents).set({ revokedAt: new Date() }).where(and(eq(pgSchema.consents.userId, userId), eq(pgSchema.consents.kind, kind), isNull(pgSchema.consents.revokedAt)))
    await audit(tx, { userId, actor: "user", action: "consent.revoke", data: { kind }, ipHash: meta.ipHash })
  })
}

/** kind -> granted (latest row for the kind has no revoked_at) and whether it is the current version. */
export async function currentConsents(userId: string): Promise<Record<LegalKind, { granted: boolean; current: boolean; at: string | null }>> {
  const rows = await withUser(userId, (tx) => tx.select({ kind: pgSchema.consents.kind, grantedAt: pgSchema.consents.grantedAt, revokedAt: pgSchema.consents.revokedAt, version: pgSchema.legalDocuments.version }).from(pgSchema.consents).innerJoin(pgSchema.legalDocuments, eq(pgSchema.consents.legalDocumentId, pgSchema.legalDocuments.id)).where(eq(pgSchema.consents.userId, userId)).orderBy(desc(pgSchema.consents.grantedAt)))
  const out = {} as Record<LegalKind, { granted: boolean; current: boolean; at: string | null }>
  for (const kind of Object.keys(LEGAL) as LegalKind[]) {
    const latest = rows.find((r) => r.kind === kind)
    const granted = !!latest && !latest.revokedAt
    out[kind] = { granted, current: granted && latest!.version === LEGAL[kind].version, at: latest?.grantedAt.toISOString() ?? null }
  }
  return out
}
