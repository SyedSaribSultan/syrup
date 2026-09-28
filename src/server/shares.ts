import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm"
import { unstable_cache } from "next/cache"
import { DEBUG_LINK_TTL_S, isShareId, type ShareInfo } from "@/lib/share-link"
import { buildDebug, buildTranscript, TranscriptTooLarge, type DebugBundle, type DebugLog, type DebugRouterEvent, type RawMessage, type RawPart, type Transcript } from "@/lib/transcript"
import type { PathOptions, RedactOptions } from "@/lib/redact"
import { db, dbReady, schema } from "./db"
import { pg, pgReady, pgSchema, withUser } from "./db/pg"
import { deriveKey as cloudDeriveKey } from "./cloud/crypto"
import { env } from "./env"
import { invalidateShare, shareTag } from "./share-cache"
import { deriveKey as vaultDeriveKey } from "./vault"

/**
 * Share links, both modes. A share is a sanitized snapshot of one chat
 * (src/lib/transcript.ts) stored under an unguessable id:
 * - local: SQLite shared_chats, built from the local engine;
 * - cloud: Postgres shared_chats (RLS per user), built from the messages the
 *   sandbox sidecar already mirrored into Postgres, so sharing works while the
 *   sandbox sleeps. The public viewer reads through get_shared_chat() only.
 * Errors are thrown as Responses for handler() (cloud/session.ts).
 */

export type Owner = { mode: "local" } | { mode: "cloud"; userId: string; email: string }

/** Share creations and updates per owner per hour. */
const RATE_PER_HOUR = 30
/** Live links per owner. */
const MAX_LIVE = 500
/** Minimum gap between two updates of one link. */
const UPDATE_COOLDOWN_MS = 5_000

const CLOUD_PATHS: PathOptions = { roots: ["/vercel/workspace", "/vercel/repo"], homes: ["/vercel"] }

const fail = (status: number, error: string) => Response.json({ error }, { status })

// ------------------------------------------------------------------ ids, urls, signing

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** 22 base62 characters from the CSPRNG (rejection sampling, no modulo bias): about 131 bits. */
export function newShareId(): string {
  let out = ""
  while (out.length < 22) {
    for (const b of crypto.randomBytes(32)) {
      if (b < 248 && out.length < 22) out += B62[b % 62]
    }
  }
  return out
}

/** The origin the client used (Host header), which Next may otherwise report as localhost for a 127.0.0.1 server. */
export function requestOrigin(req: Request): string {
  const u = new URL(req.url)
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  const proto = (req.headers.get("x-forwarded-proto") ?? u.protocol.replace(/:$/, "")).split(",")[0].trim()
  return host && /^[A-Za-z0-9.\-:[\]]+$/.test(host) && /^https?$/.test(proto) ? `${proto}://${host}` : u.origin
}

/** Public base URL for links: the configured app URL in the cloud, else the origin the owner is using. */
export function publicBase(origin: string): string {
  return (env.isCloud && process.env.NEXT_PUBLIC_APP_URL ? process.env.NEXT_PUBLIC_APP_URL : origin).replace(/\/+$/, "")
}

/** HMAC key for debug links: derived from SYRUP_MASTER_KEY in the cloud, from the local vault key otherwise (stable across restarts). */
function debugKey(): Buffer {
  const label = "syrup/share-debug-link/v1"
  return env.isCloud ? cloudDeriveKey(label) : vaultDeriveKey(label)
}

export function debugSignature(id: string, exp: number): string {
  return crypto.createHmac("sha256", debugKey()).update(`${id}.${exp}`).digest("base64url")
}

/** Signed, expiring link to the owner's debug bundle. */
export function debugLink(origin: string, id: string, ttlS = DEBUG_LINK_TTL_S): { url: string; expiresAt: number } {
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.min(ttlS, DEBUG_LINK_TTL_S))
  return { url: `${publicBase(origin)}/c/${id}/debug?exp=${exp}&sig=${debugSignature(id, exp)}`, expiresAt: exp * 1000 }
}

export function verifyDebug(id: string, expRaw: string | null, sig: string | null): "ok" | "expired" | "invalid" {
  if (!expRaw || !sig || !/^\d{9,11}$/.test(expRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return "invalid"
  const exp = Number(expRaw)
  const want = Buffer.from(debugSignature(id, exp))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return "invalid"
  const now = Math.floor(Date.now() / 1000)
  if (exp <= now) return "expired"
  // A valid signature never claims more than the TTL (plus clock slack).
  if (exp > now + DEBUG_LINK_TTL_S + 300) return "invalid"
  return "ok"
}

// ------------------------------------------------------------------ secrets known to the server (redacted verbatim wherever they appear)

const SECRET_ENV = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL)/i

function envSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([k, v]) => !!v && v.length >= 12 && SECRET_ENV.test(k) && !k.startsWith("NEXT_PUBLIC_"))
    .map(([, v]) => v as string)
}

async function localSecrets(): Promise<string[]> {
  const out = [env.internalSecret, ...envSecrets()]
  await dbReady()
  const rows = await db().select({ secret: schema.providerKeys.secret }).from(schema.providerKeys)
  const { open } = await import("./vault")
  for (const r of rows) {
    try {
      out.push(open(r.secret))
    } catch {}
  }
  return out
}

async function cloudSecrets(userId: string): Promise<string[]> {
  const { openWith, userDek } = await import("./cloud/crypto")
  const out = envSecrets()
  await withUser(userId, async (tx) => {
    const dek = await userDek(tx, userId)
    const keys = await tx.select({ s: pgSchema.providerKeys.secretEnc }).from(pgSchema.providerKeys).where(eq(pgSchema.providerKeys.userId, userId))
    const [u] = await tx.select({ gh: pgSchema.users.githubTokenEnc }).from(pgSchema.users).where(eq(pgSchema.users.id, userId))
    for (const sealed of [...keys.map((k) => k.s), u?.gh].filter((x): x is string => !!x)) {
      try {
        out.push(openWith(dek, sealed))
      } catch {}
    }
  })
  return out
}

function localPaths(directory: string): PathOptions {
  return { roots: [directory, env.workspace], homes: [os.homedir()] }
}

async function sanitizeOptions(owner: Owner): Promise<RedactOptions> {
  if (owner.mode === "local") return { secrets: await localSecrets() }
  return { secrets: await cloudSecrets(owner.userId), hide: [{ value: owner.email, as: "[email]" }] }
}

// ------------------------------------------------------------------ snapshots

type LocalSession = { id: string; title: string; directory: string; parentID?: string; time: { created: number; updated: number } }

async function localEngine() {
  const { engine } = await import("./engine/opencode")
  return engine()
}

/** Folders chats may live in: the engine's git projects, the Home workspace (~/syrup, see api/workspace/home), syrup's own folder, and folders recent prompts came from. */
async function localDirectories(first?: string): Promise<string[]> {
  const e = await localEngine()
  const res = await e.client.project.list().catch(() => null)
  await dbReady()
  const l = schema.logs
  const recent = await db()
    .selectDistinct({ directory: l.directory })
    .from(l)
    .where(and(eq(l.event, "prompt.sent"), isNotNull(l.directory), gt(l.ts, Date.now() - 30 * 86_400_000)))
    .limit(50)
    .catch(() => [])
  const dirs = [first, ...(res?.data ?? []).map((p) => p.worktree), path.join(os.homedir(), "syrup"), env.workspace, ...recent.map((r) => r.directory)].filter((d): d is string => !!d && d !== "/" && d.length > 2)
  return [...new Set(dirs)]
}

async function findLocalSession(sessionId: string, directory?: string): Promise<LocalSession | null> {
  const e = await localEngine()
  for (const dir of await localDirectories(directory)) {
    const r = await e.client.session.get({ path: { id: sessionId }, query: { directory: dir } }).catch(() => null)
    const s = r?.data as (LocalSession & { directory?: string }) | undefined
    if (s?.id) return { ...s, directory: s.directory || dir }
  }
  return null
}

async function latestLocalSession(): Promise<LocalSession | null> {
  const e = await localEngine()
  let best: LocalSession | null = null
  // The chat of the most recent prompt syrup logged (the browser logs every send with its session and folder).
  await dbReady()
  const l = schema.logs
  const [last] = await db().select({ sessionId: l.sessionId, directory: l.directory }).from(l).where(and(eq(l.event, "prompt.sent"), isNotNull(l.sessionId))).orderBy(desc(l.ts)).limit(1)
  if (last?.sessionId) best = await findLocalSession(last.sessionId, last.directory ?? undefined)
  for (const dir of await localDirectories()) {
    const r = await e.client.session.list({ query: { directory: dir } }).catch(() => null)
    for (const s of (r?.data ?? []) as LocalSession[]) {
      if (s.parentID) continue
      if (!best || (s.time.updated ?? s.time.created) > (best.time.updated ?? best.time.created)) best = { ...s, directory: s.directory || dir }
    }
  }
  return best
}

type Snapshot = { transcript: Transcript; sessionId: string; directory?: string; workspaceId?: string; paths: PathOptions; secrets: RedactOptions }

async function localSnapshot(sessionId: string, directory?: string): Promise<Snapshot> {
  const sess = sessionId === "latest" ? await latestLocalSession() : await findLocalSession(sessionId, directory)
  if (!sess) throw fail(404, "chat not found")
  const e = await localEngine()
  const msgs = await e.client.session.messages({ path: { id: sess.id }, query: { directory: sess.directory } })
  if (!msgs.data) throw fail(502, "the engine did not return this chat's messages")
  const { localSessionAnswers } = await import("./router-status")
  const [answers, secrets] = await Promise.all([localSessionAnswers(sess.id), sanitizeOptions({ mode: "local" })])
  const paths = localPaths(sess.directory)
  const transcript = build({ title: sess.title, messages: msgs.data as unknown as RawMessage[], answers, createdAt: sess.time.created, updatedAt: sess.time.updated, paths, secrets })
  return { transcript, sessionId: sess.id, directory: sess.directory, paths, secrets }
}

async function cloudSnapshot(owner: Extract<Owner, { mode: "cloud" }>, sessionId: string, workspaceId?: string): Promise<Snapshot> {
  const cs = pgSchema.chatSessions
  const ws = pgSchema.workspaces
  const m = pgSchema.messages
  const data = await withUser(owner.userId, async (tx) => {
    const [sess] =
      sessionId === "latest"
        ? await tx
            .select({ id: cs.id, title: cs.title, workspaceId: cs.workspaceId, createdAt: cs.createdAt, updatedAt: cs.updatedAt, deletedAt: cs.deletedAt })
            .from(cs)
            .innerJoin(ws, eq(ws.id, cs.workspaceId))
            .where(and(eq(cs.userId, owner.userId), isNull(cs.deletedAt), isNull(cs.parentId), isNull(ws.deletedAt)))
            .orderBy(desc(cs.updatedAt))
            .limit(1)
        : await tx.select({ id: cs.id, title: cs.title, workspaceId: cs.workspaceId, createdAt: cs.createdAt, updatedAt: cs.updatedAt, deletedAt: cs.deletedAt }).from(cs).where(and(eq(cs.id, sessionId), eq(cs.userId, owner.userId)))
    if (!sess || sess.deletedAt) return null
    const [w] = await tx.select({ deletedAt: ws.deletedAt }).from(ws).where(and(eq(ws.id, sess.workspaceId), eq(ws.userId, owner.userId)))
    if (!w || w.deletedAt) return null
    const rows = await tx.select({ info: m.info, parts: m.parts }).from(m).where(and(eq(m.userId, owner.userId), eq(m.sessionId, sess.id))).orderBy(asc(m.createdAt))
    return { sess, rows }
  })
  if (!data || (workspaceId && data.sess.workspaceId !== workspaceId)) throw fail(404, "chat not found")
  const { cloudSessionAnswers } = await import("./router-status")
  const [answers, secrets] = await Promise.all([cloudSessionAnswers(owner.userId, data.sess.id), sanitizeOptions(owner)])
  const messages: RawMessage[] = data.rows
    .filter((r) => r.info && typeof r.info === "object")
    .map((r) => ({ info: r.info as RawMessage["info"], parts: Object.values((r.parts ?? {}) as Record<string, RawPart>) }))
  const transcript = build({ title: data.sess.title ?? "", messages, answers, createdAt: data.sess.createdAt.getTime(), updatedAt: data.sess.updatedAt.getTime(), paths: CLOUD_PATHS, secrets })
  return { transcript, sessionId: data.sess.id, workspaceId: data.sess.workspaceId, paths: CLOUD_PATHS, secrets }
}

/**
 * One cloud chat as the admin research export sees it (src/app/api/admin/research-export): the same sanitized
 * transcript a share link gets, built in that user's scope. Null when the chat is gone or too large.
 */
export async function researchTranscript(user: { id: string; email: string }, sessionId: string): Promise<Transcript | null> {
  try {
    return (await cloudSnapshot({ mode: "cloud", userId: user.id, email: user.email }, sessionId)).transcript
  } catch {
    return null
  }
}

function build(input: Parameters<typeof buildTranscript>[0]): Transcript {
  try {
    return buildTranscript(input)
  } catch (err) {
    if (err instanceof TranscriptTooLarge) throw fail(413, err.message)
    throw err
  }
}

async function snapshotFor(owner: Owner, input: { sessionId: string; workspaceId?: string | null; directory?: string | null }): Promise<Snapshot> {
  return owner.mode === "local" ? localSnapshot(input.sessionId, input.directory ?? undefined) : cloudSnapshot(owner, input.sessionId, input.workspaceId ?? undefined)
}

// ------------------------------------------------------------------ owner operations

type Row = {
  id: string
  sessionId: string
  workspaceId: string | null
  directory: string | null
  title: string
  models: string[]
  messageCount: number
  bytes: number
  redactions: number
  views: number
  createdAt: number
  updatedAt: number
}

function info(r: Row, origin: string, t?: Pick<Transcript, "stats" | "notes"> | null): ShareInfo {
  return {
    id: r.id,
    url: `${publicBase(origin)}/c/${r.id}`,
    sessionId: r.sessionId,
    workspaceId: r.workspaceId,
    title: r.title,
    models: r.models,
    messageCount: r.messageCount,
    bytes: r.bytes,
    redactions: r.redactions,
    views: r.views,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(t?.stats
      ? {
          stats: {
            messages: t.stats.messages,
            toolCalls: t.stats.toolCalls,
            toolErrors: t.stats.toolErrors,
            attachments: t.stats.attachments,
            attachmentsDropped: t.stats.attachmentsDropped,
            reasoning: t.stats.reasoning,
            redactions: t.stats.redactions,
          },
          notes: t.notes ?? [],
        }
      : {}),
  }
}

function parseJSON<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return (s as T) ?? fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const local = () => schema.sharedChats
const cloud = () => pgSchema.sharedChats

function localRow(r: typeof schema.sharedChats.$inferSelect | Omit<typeof schema.sharedChats.$inferSelect, "snapshot">): Row {
  return { id: r.id, sessionId: r.sessionId, workspaceId: null, directory: r.directory, title: r.title, models: parseJSON<string[]>(r.models, []), messageCount: r.messageCount, bytes: r.bytes, redactions: r.redactions, views: r.views, createdAt: r.createdAt, updatedAt: r.updatedAt }
}

function cloudRow(r: Omit<typeof pgSchema.sharedChats.$inferSelect, "snapshot" | "userId">): Row {
  return { id: r.id, sessionId: r.sessionId, workspaceId: r.workspaceId, directory: null, title: r.title, models: r.models, messageCount: r.messageCount, bytes: r.bytes, redactions: r.redactions, views: r.views, createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime() }
}

const cloudCols = () => {
  const t = cloud()
  return { id: t.id, workspaceId: t.workspaceId, sessionId: t.sessionId, title: t.title, models: t.models, messageCount: t.messageCount, bytes: t.bytes, redactions: t.redactions, views: t.views, createdAt: t.createdAt, updatedAt: t.updatedAt, revokedAt: t.revokedAt }
}
const localCols = () => {
  const t = local()
  return { id: t.id, directory: t.directory, sessionId: t.sessionId, title: t.title, models: t.models, messageCount: t.messageCount, bytes: t.bytes, redactions: t.redactions, views: t.views, createdAt: t.createdAt, updatedAt: t.updatedAt, revokedAt: t.revokedAt }
}

/** Creations and updates in the last hour, and live links; throws 429 when over. */
async function checkRate(owner: Owner): Promise<void> {
  const since = Date.now() - 3_600_000
  let recent: number
  let live: number
  if (owner.mode === "local") {
    await dbReady()
    const t = local()
    const [a] = await db().select({ n: sql<number>`count(*)` }).from(t).where(or(gt(t.createdAt, since), gt(t.updatedAt, since)))
    const [b] = await db().select({ n: sql<number>`count(*)` }).from(t).where(isNull(t.revokedAt))
    recent = Number(a?.n ?? 0)
    live = Number(b?.n ?? 0)
  } else {
    const t = cloud()
    const r = await withUser(owner.userId, async (tx) => {
      const [a] = await tx.select({ n: sql<number>`count(*)::int` }).from(t).where(and(eq(t.userId, owner.userId), or(gt(t.createdAt, new Date(since)), gt(t.updatedAt, new Date(since)))))
      const [b] = await tx.select({ n: sql<number>`count(*)::int` }).from(t).where(and(eq(t.userId, owner.userId), isNull(t.revokedAt)))
      return { recent: Number(a?.n ?? 0), live: Number(b?.n ?? 0) }
    })
    recent = r.recent
    live = r.live
  }
  if (recent >= RATE_PER_HOUR) throw fail(429, `That's ${RATE_PER_HOUR} share links in the last hour. Give it a few minutes.`)
  if (live >= MAX_LIVE) throw fail(429, `You have ${MAX_LIVE} live share links. Stop sharing a few in Shared links first.`)
}

async function findLive(owner: Owner, by: { id?: string; sessionId?: string }): Promise<Row | null> {
  if (owner.mode === "local") {
    await dbReady()
    const t = local()
    const [r] = await db()
      .select(localCols())
      .from(t)
      .where(and(by.id ? eq(t.id, by.id) : undefined, by.sessionId ? eq(t.sessionId, by.sessionId) : undefined, isNull(t.revokedAt)))
      .orderBy(desc(t.createdAt))
      .limit(1)
    return r ? localRow(r) : null
  }
  const t = cloud()
  const [r] = await withUser(owner.userId, (tx) =>
    tx
      .select(cloudCols())
      .from(t)
      .where(and(eq(t.userId, owner.userId), by.id ? eq(t.id, by.id) : undefined, by.sessionId ? eq(t.sessionId, by.sessionId) : undefined, isNull(t.revokedAt)))
      .orderBy(desc(t.createdAt))
      .limit(1),
  )
  return r ? cloudRow(r) : null
}

async function statsOf(owner: Owner, id: string): Promise<Pick<Transcript, "stats" | "notes"> | null> {
  if (owner.mode === "local") {
    const t = local()
    const [r] = await db()
      .select({ stats: sql<string>`json_extract(${t.snapshot}, '$.stats')`, notes: sql<string>`json_extract(${t.snapshot}, '$.notes')` })
      .from(t)
      .where(eq(t.id, id))
    return r ? { stats: parseJSON(r.stats, null as never), notes: parseJSON<string[]>(r.notes, []) } : null
  }
  const t = cloud()
  const [r] = await withUser(owner.userId, (tx) => tx.select({ stats: sql<Transcript["stats"]>`${t.snapshot}->'stats'`, notes: sql<string[]>`${t.snapshot}->'notes'` }).from(t).where(and(eq(t.id, id), eq(t.userId, owner.userId))))
  return r ? { stats: r.stats, notes: r.notes ?? [] } : null
}

/** Creates a link for a chat, or returns the live one it already has. */
export async function createShare(owner: Owner, input: { sessionId: string; workspaceId?: string | null; directory?: string | null }, origin: string): Promise<{ share: ShareInfo; existing: boolean }> {
  const existing = await findLive(owner, { sessionId: input.sessionId })
  if (existing) return { share: info(existing, origin, await statsOf(owner, existing.id)), existing: true }
  await checkRate(owner)
  const snap = await snapshotFor(owner, input)
  const t = snap.transcript
  const id = newShareId()
  const now = Date.now()
  let row: Row
  if (owner.mode === "local") {
    await db()
      .insert(local())
      .values({ id, directory: snap.directory ?? env.workspace, sessionId: snap.sessionId, title: t.title, snapshot: JSON.stringify(t), models: JSON.stringify(t.models), messageCount: t.stats.messages, bytes: t.stats.bytes, redactions: t.stats.redactions, createdAt: now, updatedAt: now })
    row = { id, sessionId: snap.sessionId, workspaceId: null, directory: snap.directory ?? null, title: t.title, models: t.models, messageCount: t.stats.messages, bytes: t.stats.bytes, redactions: t.stats.redactions, views: 0, createdAt: now, updatedAt: now }
  } else {
    const [r] = await withUser(owner.userId, (tx) =>
      tx
        .insert(cloud())
        .values({ id, userId: owner.userId, workspaceId: snap.workspaceId!, sessionId: snap.sessionId, title: t.title, snapshot: t, models: t.models, messageCount: t.stats.messages, bytes: t.stats.bytes, redactions: t.stats.redactions, createdAt: new Date(now), updatedAt: new Date(now) })
        .returning(cloudCols()),
    )
    row = cloudRow(r)
    const { audit } = await import("./cloud/audit")
    await withUser(owner.userId, (tx) => audit(tx, { userId: owner.userId, actor: "user", action: "share.create", target: id, data: { sessionId: snap.sessionId, bytes: t.stats.bytes, redactions: t.stats.redactions } })).catch(() => {})
  }
  invalidateShare(id)
  return { share: info(row, origin, t), existing: false }
}

/** Re-snapshots a live link now (the same URL then shows the chat as it is). */
export async function updateShare(owner: Owner, id: string, origin: string): Promise<ShareInfo> {
  if (!isShareId(id)) throw fail(404, "share not found")
  const cur = await findLive(owner, { id })
  if (!cur) throw fail(404, "share not found")
  if (Date.now() - cur.updatedAt < UPDATE_COOLDOWN_MS) throw fail(429, "Just updated. Try again in a few seconds.")
  await checkRate(owner)
  const snap = await snapshotFor(owner, { sessionId: cur.sessionId, workspaceId: cur.workspaceId, directory: cur.directory })
  const t = snap.transcript
  const now = Date.now()
  const set = { title: t.title, messageCount: t.stats.messages, bytes: t.stats.bytes, redactions: t.stats.redactions }
  if (owner.mode === "local") {
    const tb = local()
    await db()
      .update(tb)
      .set({ ...set, snapshot: JSON.stringify(t), models: JSON.stringify(t.models), updatedAt: now })
      .where(and(eq(tb.id, id), isNull(tb.revokedAt)))
  } else {
    const tb = cloud()
    await withUser(owner.userId, (tx) =>
      tx
        .update(tb)
        .set({ ...set, snapshot: t, models: t.models, updatedAt: new Date(now) })
        .where(and(eq(tb.id, id), eq(tb.userId, owner.userId), isNull(tb.revokedAt))),
    )
  }
  invalidateShare(id)
  return info({ ...cur, ...set, models: t.models, updatedAt: now }, origin, t)
}

/** Stops sharing: the link 404s from the next request on. The row stays so the id is never reused. */
export async function revokeShare(owner: Owner, id: string): Promise<void> {
  if (!isShareId(id)) throw fail(404, "share not found")
  let n = 0
  if (owner.mode === "local") {
    await dbReady()
    const t = local()
    const r = await db().update(t).set({ revokedAt: Date.now() }).where(and(eq(t.id, id), isNull(t.revokedAt))).returning({ id: t.id })
    n = r.length
  } else {
    const t = cloud()
    const r = await withUser(owner.userId, async (tx) => {
      const out = await tx.update(t).set({ revokedAt: new Date() }).where(and(eq(t.id, id), eq(t.userId, owner.userId), isNull(t.revokedAt))).returning({ id: t.id })
      if (out.length) {
        const { audit } = await import("./cloud/audit")
        await audit(tx, { userId: owner.userId, actor: "user", action: "share.revoke", target: id })
      }
      return out
    })
    n = r.length
  }
  invalidateShare(id)
  if (!n) throw fail(404, "share not found")
}

/** The owner's live links, newest first. With a session id: that chat's link, with its counts. */
export async function listShares(owner: Owner, origin: string, opts: { sessionId?: string } = {}): Promise<ShareInfo[]> {
  if (opts.sessionId) {
    const r = await findLive(owner, { sessionId: opts.sessionId })
    return r ? [info(r, origin, await statsOf(owner, r.id))] : []
  }
  if (owner.mode === "local") {
    await dbReady()
    const t = local()
    const rows = await db().select(localCols()).from(t).where(isNull(t.revokedAt)).orderBy(desc(t.createdAt)).limit(MAX_LIVE)
    return rows.map((r) => info(localRow(r), origin))
  }
  const t = cloud()
  const rows = await withUser(owner.userId, (tx) => tx.select(cloudCols()).from(t).where(and(eq(t.userId, owner.userId), isNull(t.revokedAt))).orderBy(desc(t.createdAt)).limit(MAX_LIVE))
  return rows.map((r) => info(cloudRow(r), origin))
}

/** Revokes every live link of a chat (the chat was deleted). Local mode; the cloud does this while ingesting the delete. */
export async function revokeLocalSessionShares(sessionId: string): Promise<void> {
  await dbReady()
  const t = local()
  const r = await db().update(t).set({ revokedAt: Date.now() }).where(and(eq(t.sessionId, sessionId), isNull(t.revokedAt))).returning({ id: t.id })
  for (const x of r) invalidateShare(x.id)
}

// ------------------------------------------------------------------ public reads

type Stored = { id: string; title: string; transcript: Transcript; createdAt: number; updatedAt: number; owner: { userId?: string; workspaceId?: string; directory?: string; sessionId: string } }

/** One live share, uncached. The only cloud read path is get_shared_chat(), which hides revoked rows and deleted accounts. */
async function readShare(id: string): Promise<Stored | null> {
  if (!isShareId(id)) return null
  if (!env.isCloud) {
    await dbReady()
    const t = local()
    const [r] = await db().select().from(t).where(and(eq(t.id, id), isNull(t.revokedAt)))
    if (!r) return null
    return { id: r.id, title: r.title, transcript: parseJSON<Transcript>(r.snapshot, null as never), createdAt: r.createdAt, updatedAt: r.updatedAt, owner: { directory: r.directory, sessionId: r.sessionId } }
  }
  await pgReady()
  const res = await pg().execute<{ id: string; user_id: string; workspace_id: string; session_id: string; title: string; snapshot: Transcript | string; created_at: Date | string; updated_at: Date | string }>(sql`select id, user_id, workspace_id, session_id, title, snapshot, created_at, updated_at from get_shared_chat(${id})`)
  const r = res.rows[0]
  if (!r) return null
  return {
    id: r.id,
    title: r.title,
    transcript: typeof r.snapshot === "string" ? parseJSON<Transcript>(r.snapshot, null as never) : r.snapshot,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
    owner: { userId: r.user_id, workspaceId: r.workspace_id, sessionId: r.session_id },
  }
}

export type PublicShare = { id: string; title: string; transcript: Transcript; createdAt: number; updatedAt: number }

/** A live share for the public viewer, cached per id under its tag (expired on every write). Never carries owner ids. */
export function getPublicShare(id: string): Promise<PublicShare | null> {
  if (!isShareId(id)) return Promise.resolve(null)
  return unstable_cache(
    async (): Promise<PublicShare | null> => {
      const s = await readShare(id)
      return s && s.transcript ? { id: s.id, title: s.title, transcript: s.transcript, createdAt: s.createdAt, updatedAt: s.updatedAt } : null
    },
    ["syrup-share-v1", id],
    { tags: [shareTag(id)], revalidate: 3600 },
  )()
}

/** Counts one view of a live share. Best effort. */
export async function countView(id: string): Promise<void> {
  if (!isShareId(id)) return
  if (!env.isCloud) {
    await dbReady()
    const t = local()
    await db()
      .update(t)
      .set({ views: sql`${t.views} + 1` })
      .where(and(eq(t.id, id), isNull(t.revokedAt)))
    return
  }
  await pgReady()
  await pg().execute(sql`select bump_shared_chat_views(${id})`)
}

// ------------------------------------------------------------------ debug bundle

async function routerEventsFor(owner: { userId?: string }, sessionId: string): Promise<DebugRouterEvent[]> {
  if (!env.isCloud) {
    await dbReady()
    const r = schema.routerEvents
    const rows = await db().select().from(r).where(eq(r.sessionId, sessionId)).orderBy(asc(r.ts)).limit(2000)
    return rows.map((e) => ({ ts: e.ts, alias: e.alias, provider: e.providerId, model: e.modelId, tier: e.tier, status: e.status, httpStatus: e.httpStatus, attempts: e.attempts, latencyMs: e.latencyMs, ttftMs: e.ttftMs, inputTokens: e.inputTokens, outputTokens: e.outputTokens, cost: e.cost, reason: e.reason, error: e.error, retryAt: e.retryAt }))
  }
  if (!owner.userId) return []
  const userId = owner.userId
  const r = pgSchema.routerEvents
  const rows = await withUser(userId, (tx) => tx.select().from(r).where(and(eq(r.userId, userId), eq(r.sessionId, sessionId))).orderBy(asc(r.ts)).limit(2000))
  return rows.map((e) => ({ ts: e.ts.getTime(), alias: e.alias, provider: e.providerId, model: e.modelId, tier: e.tier, status: e.status, httpStatus: e.httpStatus, attempts: e.attempts, latencyMs: e.latencyMs, ttftMs: e.ttftMs, inputTokens: e.inputTokens, outputTokens: e.outputTokens, cost: e.cost, reason: e.reason, error: e.error, retryAt: e.retryAt ? e.retryAt.getTime() : null }))
}

async function logsFor(owner: { userId?: string }, sessionId: string, since: number): Promise<DebugLog[]> {
  const rows = !env.isCloud
    ? await (await import("./log")).queryLogs({ sessionId, since, limit: 1000 })
    : owner.userId
      ? await (await import("./cloud/logs")).queryCloudLogs(owner.userId, { sessionId, since, limit: 1000 })
      : []
  return [...rows].reverse().map((r) => ({ ts: r.ts, level: r.level, source: r.source, event: r.event, data: parseJSON<unknown>(r.data, r.data) }))
}

async function debugFor(owner: Owner, snap: Pick<Snapshot, "transcript" | "sessionId" | "paths" | "secrets">, extra: { share?: DebugBundle["share"]; expiresAt?: number } = {}): Promise<DebugBundle> {
  const ids = owner.mode === "cloud" ? { userId: owner.userId } : {}
  const [events, logs] = await Promise.all([routerEventsFor(ids, snap.sessionId), logsFor(ids, snap.sessionId, snap.transcript.createdAt - 10 * 60_000)])
  return buildDebug({ sessionId: snap.sessionId, transcript: snap.transcript, events, logs, paths: snap.paths, secrets: snap.secrets, ...extra })
}

/** The owner's debug bundle behind a signed link: the stored snapshot plus live router events and logs for the chat. */
export async function debugBundleForShare(id: string, expiresAt: number): Promise<DebugBundle | null> {
  const s = await readShare(id)
  if (!s?.transcript) return null
  // The owner of a cloud share, for scoping reads; email only feeds redaction.
  let owner: Owner = { mode: "local" }
  if (env.isCloud) {
    if (!s.owner.userId) return null
    const [u] = await pg().select({ email: pgSchema.users.email }).from(pgSchema.users).where(eq(pgSchema.users.id, s.owner.userId))
    owner = { mode: "cloud", userId: s.owner.userId, email: u?.email ?? "" }
  }
  const paths = owner.mode === "local" ? localPaths(s.owner.directory ?? env.workspace) : CLOUD_PATHS
  const secrets = await sanitizeOptions(owner)
  return debugFor(owner, { transcript: s.transcript, sessionId: s.owner.sessionId, paths, secrets }, { share: { id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt }, expiresAt })
}

/** A chat's transcript for the owner, without creating a link (exports, `pnpm chat:export`). `sessionId` may be "latest". */
export async function exportForOwner(owner: Owner, input: { sessionId: string; workspaceId?: string | null; directory?: string | null; debug?: boolean }): Promise<{ transcript: Transcript; sessionId: string; debug?: DebugBundle }> {
  const snap = await snapshotFor(owner, input)
  if (!input.debug) return { transcript: snap.transcript, sessionId: snap.sessionId }
  return { transcript: snap.transcript, sessionId: snap.sessionId, debug: await debugFor(owner, snap) }
}

/** A signed debug link for one of the owner's live links. `ttlS` is capped at 24 hours. */
export async function debugLinkForOwner(owner: Owner, id: string, origin: string, ttlS?: number): Promise<{ url: string; expiresAt: number }> {
  if (!isShareId(id) || !(await findLive(owner, { id }))) throw fail(404, "share not found")
  return debugLink(origin, id, ttlS)
}
