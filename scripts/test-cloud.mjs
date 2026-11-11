#!/usr/bin/env node
/**
 * Cloud state machines on a real Postgres schema: sandbox start and stop, account deletion and blocking, data requests,
 * analytics opt-out, consent, ingest tokens, workspaces and history. The modules are bundled with esbuild like
 * scripts/test-guard.mjs; the database is PGlite in memory with every drizzle-pg migration applied and row-level
 * security enforced (scripts/fixtures/cloud/pg.ts), and Vercel Sandbox is a fake (scripts/fixtures/cloud/sandbox.ts).
 * No network, no real database, no engine.
 *
 *   node scripts/test-cloud.mjs
 */
import { build } from "esbuild"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "node_modules", ".cache", "syrup-cloud-test")
fs.mkdirSync(outDir, { recursive: true })

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : err}`)
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`)
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}

Object.assign(process.env, {
  SYRUP_MODE: "cloud",
  SYRUP_MASTER_KEY: crypto.randomBytes(32).toString("base64"),
  SYRUP_ADMIN_EMAILS: "admin@test",
  NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
  CRON_SECRET: "cron-secret",
  SYRUP_SANDBOX_MAX_RUNNING: "1",
  SYRUP_SANDBOX_DAILY_SECONDS: "7200",
})

// ---- Stubs: the platform pieces a test cannot run. Each shares its state through globalThis with the test. ----
const fixtures = path.join(root, "scripts", "fixtures", "cloud")
const STUBS = {
  "next/server": `export const after = (fn) => { void Promise.resolve().then(typeof fn === "function" ? fn : () => fn).catch(() => {}) }`,
  "next/headers": `export const headers = async () => new Headers(globalThis.__headers ?? {})`,
  "next/cache": `export const revalidateTag = () => {}; export const revalidatePath = () => {}; export const unstable_cache = (fn) => fn`,
  "@/auth": `export const auth = async () => globalThis.__session ?? null; export const signIn = async () => {}; export const signOut = async () => {}; export const handlers = {}`,
  "posthog-node": `export class PostHog {
    capture(e) { (globalThis.__ph ??= []).push(["capture", e.distinctId, e.event]) }
    identify(e) { (globalThis.__ph ??= []).push(["identify", e.distinctId]) }
    async flush() {}
    async captureExceptionImmediate() {}
  }`,
}
const stubPlugin = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^(next\/server|next\/headers|next\/cache|@\/auth|posthog-node)$/ }, (a) => ({ path: a.path, namespace: "stub" }))
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js" }))
    // The database and the sandbox platform.
    b.onResolve({ filter: /(^|\/)db\/pg$/ }, () => ({ path: path.join(fixtures, "pg.ts") }))
    b.onResolve({ filter: /^@vercel\/sandbox$/ }, () => ({ path: path.join(fixtures, "sandbox.ts") }))
  },
}

const entry = `
export * as sandbox from "@/server/engine/sandbox"
export * as workspaces from "@/server/cloud/workspaces"
export * as history from "@/server/cloud/history"
export * as legal from "@/server/cloud/legal"
export * as analytics from "@/server/analytics"
export * as ingest from "@/server/cloud/ingest"
export * as keys from "@/server/cloud/keys"
export * as memory from "@/server/cloud/memory"
export * as session from "@/server/cloud/session"
export * as db from "@/server/db/pg"
export * as fake from "${path.join(fixtures, "sandbox.ts").replaceAll("\\", "/")}"
export * as cron from "@/app/api/cron/daily/route"
export * as dataRequests from "@/app/api/data-requests/route"
export * as adminUsers from "@/app/api/admin/users/route"
export * as researchExport from "@/app/api/admin/research-export/route"
export * as ingestRoute from "@/app/api/ingest/[...op]/route"
export * as wsRoute from "@/app/api/workspaces/[id]/route"
`
const outfile = path.join(outDir, "cloud.mjs")
await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts" },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  tsconfig: path.join(root, "tsconfig.json"),
  plugins: [stubPlugin],
  packages: "external",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})
// Engines report this hash on /health, so a reused sandbox counts as current.
globalThis.__sidecarHash = JSON.parse(fs.readFileSync(path.join(root, ".sidecar", "sidecar.json"), "utf8")).hash
const m = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
const { sql } = await import("drizzle-orm")
const { pgSchema: S } = m.db
await m.db.pgReady()
const admin = () => m.db.pgAdmin()
const vms = () => m.fake.vms()
await admin().insert(S.users).values({ id: "admin-id", email: "admin@test" })

// The engine inside a fake VM: /global/health answers only to the password its latest start was given.
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const name = u.hostname.replace(/-\d+\.sandbox\.test$/, "")
  const vm = vms().get(name)
  if (u.pathname === "/global/health") {
    const auth = new Headers(init.headers).get("authorization") ?? ""
    const want = vm?.password ? `Basic ${Buffer.from(`opencode:${vm.password}`).toString("base64")}` : null
    if (!vm || vm.status !== "running" || auth !== want) return new Response("unauthorized", { status: 401 })
    return Response.json({ healthy: true, version: "1.0.0" })
  }
  return Response.json([])
}

// ---- Helpers ----
let n = 0
async function newUser(email) {
  const id = `u${++n}`
  await admin().insert(S.users).values({ id, email: email ?? `${id}@test` })
  return id
}
async function newWorkspace(userId) {
  return m.workspaces.createWorkspace(userId, { name: `ws ${++n}` })
}
async function sandboxRow(workspaceId) {
  const [r] = await admin().select().from(S.sandboxes).where(sql`workspace_id = ${workspaceId}`)
  return r
}
async function userRow(userId) {
  const [r] = await admin().select().from(S.users).where(sql`id = ${userId}`)
  return r
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function gate() {
  let open
  const p = new Promise((r) => (open = r))
  return { p, open }
}
function as(userId, email, adminFlag = false) {
  globalThis.__session = { user: { id: userId, email, admin: adminFlag } }
}
async function json(res) {
  return { status: res.status, body: await res.json().catch(() => null) }
}
const ctx = (params) => ({ params: Promise.resolve(params) })

// ================================================================ sm-syrup-sandbox-status

await check("sandbox-status: two opens at once start the engine once and hand out the password the row holds", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  const [a, b] = await Promise.all([m.sandbox.openWorkspace(u, ws.id, { exempt: true }), m.sandbox.openWorkspace(u, ws.id, { exempt: true })])
  const vm = vms().get(`ws_${ws.id.toLowerCase()}`)
  eq(vm.starts, 1, "engine starts")
  eq(a.authorization, b.authorization, "both tabs share one password")
  eq((await sandboxRow(ws.id)).status, "running", "status")
})

await check("sandbox-status: a dead opener's 'starting' expires; the relay does not treat it as a live session", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  const started = new Date(Date.now() - 10 * 60_000)
  await admin().update(S.sandboxes).set({ status: "starting", updatedAt: started, lastSessionStartedAt: started }).where(sql`workspace_id = ${ws.id}`)
  const snap = await m.keys.relayLookup(u, { reload: true })
  eq(snap.value.sessions.get(ws.id)?.live, false, "relay session live")
})

await check("sandbox-status: stop on a VM that already idled out still records the stop", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  const vm = vms().get(`ws_${ws.id.toLowerCase()}`)
  Object.assign(vm, { status: "stopped", statusUpdatedAt: new Date(), password: null })
  await m.sandbox.stopWorkspace(u, ws.id)
  const row = await sandboxRow(ws.id)
  eq(row.status, "stopped", "status")
  ok(row.lastSessionEndedAt && row.lastSessionEndedAt >= row.lastSessionStartedAt, "session closed")
  eq(row.passwordEnc, null, "password cleared")
})

await check("sandbox-status: blocking a user while their workspace is starting leaves it stopped, not running", async () => {
  const u = await newUser("blockme@test")
  const ws = await newWorkspace(u)
  const name = `ws_${ws.id.toLowerCase()}`
  // The VM does not exist yet: the open waits while the platform creates it, so a stop at this point finds nothing to stop.
  const g = gate()
  globalThis.__createGate = g.p
  const opening = m.sandbox.openWorkspace(u, ws.id, { exempt: true }).then(
    () => "opened",
    (e) => `refused: ${e.message}`,
  )
  await sleep(50)
  eq((await sandboxRow(ws.id)).status, "starting", "status while opening")
  as("admin-id", "admin@test", true)
  const r = await json(await m.adminUsers.POST(new Request("http://t/api/admin/users", { method: "POST", body: JSON.stringify({ userId: u, blocked: true }) })))
  eq(r.status, 200, "block")
  globalThis.__createGate = undefined
  g.open()
  const outcome = await opening
  ok(outcome.startsWith("refused"), `open outcome: ${outcome}`)
  eq((await sandboxRow(ws.id)).status, "stopped", "row")
  eq(vms().get(name)?.status, "stopped", "VM stopped")
})

// ================================================================ sm-syrup-sandbox-caps

await check("sandbox-caps: two opens of different workspaces at once cannot both pass a running cap of 1", async () => {
  const u = await newUser()
  const a = await newWorkspace(u)
  const b = await newWorkspace(u)
  const r = await Promise.allSettled([m.sandbox.openWorkspace(u, a.id), m.sandbox.openWorkspace(u, b.id)])
  eq(r.filter((x) => x.status === "fulfilled").length, 1, "opens that passed the cap")
})

// ================================================================ sm-syrup-engine-session

await check("engine-session: a heartbeat that finds the VM idle-stopped ends the session when the VM stopped and drops the password", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  const started = new Date(Date.now() - 5 * 60_000)
  const stoppedAt = new Date(Date.now() - 3 * 60_000)
  // Unrelated writes (a status change) must not push the end out.
  await admin().update(S.sandboxes).set({ lastSessionStartedAt: started, updatedAt: new Date() }).where(sql`workspace_id = ${ws.id}`)
  Object.assign(vms().get(`ws_${ws.id.toLowerCase()}`), { status: "stopped", statusUpdatedAt: stoppedAt, password: null })
  await m.sandbox.heartbeat(u, ws.id, { exempt: true })
  const row = await sandboxRow(ws.id)
  eq(row.status, "stopped", "status")
  eq(row.passwordEnc, null, "password cleared")
  ok(Math.abs(row.lastSessionEndedAt.getTime() - stoppedAt.getTime()) < 1000, `ended at the VM's stop, got ${row.lastSessionEndedAt.toISOString()}`)
})

await check("engine-session: the session end estimate ignores writes that did not keep the VM awake", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  const start = new Date(Date.now() - 30 * 60_000)
  // Started 30 minutes ago with a 10-minute idle timer that no heartbeat extended; a later unrelated write bumped updated_at.
  await admin().update(S.sandboxes).set({ status: "running", lastSessionStartedAt: start, idleUntil: new Date(start.getTime() + 10 * 60_000), updatedAt: new Date() }).where(sql`workspace_id = ${ws.id}`)
  const usage = await m.sandbox.sandboxUsage(u)
  ok(usage.usedSeconds <= 10 * 60 + 5, `used ${usage.usedSeconds}s, want at most 600s`)
  eq(usage.running, 0, "a session past its idle timer is not running")
})

// ================================================================ sm-syrup-account / sm-syrup-data-request

await check("account: a deletion request deactivates the account at once and stops its workspaces; it cannot be cancelled, an export can", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  as(u, `${u}@test`)
  const post = (type) => m.dataRequests.POST(new Request("http://t/api/data-requests", { method: "POST", body: JSON.stringify({ type }) })).then(json)
  const exp = await post("export")
  eq(exp.status, 200, "export request")
  eq((await json(await m.dataRequests.DELETE(new Request(`http://t/api/data-requests?id=${exp.body.request.id}`, { method: "DELETE" })))).status, 200, "cancel export")
  const [cancelled] = await admin().select().from(S.dataRequests).where(sql`id = ${exp.body.request.id}`)
  eq(cancelled.status, "cancelled", "export status")
  const del = await post("delete")
  eq(del.status, 200, "delete request")
  ok((await userRow(u)).deletedAt, "users.deleted_at set")
  eq(vms().get(`ws_${ws.id.toLowerCase()}`)?.status, "stopped", "workspace stopped")
  const after = await json(await m.dataRequests.DELETE(new Request(`http://t/api/data-requests?id=${del.body.request.id}`, { method: "DELETE" })))
  eq(after.status, 403, "account refused after deletion request")
})

await check("account: research export leaves out accounts pending deletion and uses the latest consent row", async () => {
  const pending = await newUser()
  const revoked = await newUser()
  for (const u of [pending, revoked]) await m.legal.recordConsent(u, ["research"], { ipHash: null, userAgent: null })
  await admin().update(S.users).set({ deletedAt: new Date() }).where(sql`id = ${pending}`)
  // An older unrevoked row under a newer revoked one: the latest row says no.
  const doc = await m.legal.legalDocId("research")
  await admin().update(S.consents).set({ revokedAt: new Date() }).where(sql`user_id = ${revoked}`)
  await admin().insert(S.consents).values({ id: `old-${revoked}`, userId: revoked, legalDocumentId: doc, kind: "research", grantedAt: new Date(Date.now() - 86_400_000) })
  as("admin-id", "admin@test", true)
  const res = await m.researchExport.GET()
  const [row] = await admin().select().from(S.auditLog).where(sql`action = 'research.export'`).orderBy(sql`created_at desc`).limit(1)
  await res.text()
  eq(row.data.users, 0, "users in the export")
})

await check("data-request: a deletion run killed mid-way is picked up again by the next cron", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  const old = new Date(Date.now() - 31 * 86_400_000)
  await admin().insert(S.dataRequests).values({ id: `dr-${u}`, userId: u, type: "delete", status: "running", requestedAt: old })
  await admin().update(S.users).set({ deletedAt: old }).where(sql`id = ${u}`)
  const r = await json(await m.cron.GET(new Request("http://t/api/cron/daily", { headers: { authorization: "Bearer cron-secret" } })))
  eq(r.status, 200, "cron")
  eq(await userRow(u), undefined, "user deleted")
  eq(vms().has(`ws_${ws.id.toLowerCase()}`), false, "VM deleted")
  const [receipt] = await admin().select().from(S.auditLog).where(sql`action = 'account.deleted' and target = ${u}`)
  eq(receipt?.data?.request, `dr-${u}`, "receipt names the request")
})

await check("data-request: one open request per type is enforced by the database", async () => {
  const u = await newUser()
  await admin().insert(S.dataRequests).values({ id: `a-${u}`, userId: u, type: "export" })
  let threw = false
  try {
    await admin().insert(S.dataRequests).values({ id: `b-${u}`, userId: u, type: "export" })
  } catch {
    threw = true
  }
  ok(threw, "second open export request was accepted")
})

// ================================================================ sm-syrup-analytics-optout

await check("analytics-optout: an opt-out made on another instance reaches this one", async () => {
  const u = await newUser()
  m.analytics.setOptOut(u, false)
  await admin().update(S.users).set({ analyticsOptOut: true }).where(sql`id = ${u}`)
  const realNow = Date.now
  Date.now = () => realNow() + 10 * 60_000
  try {
    globalThis.__ph = []
    await m.analytics.track(u, "x")
    eq(globalThis.__ph.length, 0, "events captured after opt-out")
  } finally {
    Date.now = realNow
  }
})

await check("analytics-optout: identify on a cold instance never identifies an opted-out user", async () => {
  const u = await newUser()
  await admin().update(S.users).set({ analyticsOptOut: true }).where(sql`id = ${u}`)
  globalThis.__ph = []
  await m.analytics.identify(u, {})
  eq(globalThis.__ph.length, 0, "identify calls")
})

// ================================================================ sm-syrup-ingest-token / account blocking

async function ingestEvents(token, events) {
  return json(await m.ingestRoute.POST(new Request("http://t/api/ingest/events", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ events }) }), ctx({ op: ["events"] })))
}
const sessionEvent = (id) => ({ type: "session.updated", properties: { info: { id, title: "t" } } })

await check("ingest-token: a sidecar of a blocked account cannot write", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  const row = await sandboxRow(ws.id)
  const token = m.ingest.mintIngestToken(u, ws.id, 60_000, row.lastSessionStartedAt.getTime())
  eq((await ingestEvents(token, [sessionEvent(`s-${u}`)])).status, 200, "live session")
  await admin().update(S.users).set({ blockedAt: new Date() }).where(sql`id = ${u}`)
  m.session.forgetBlocked(u)
  m.keys.forgetRelayKeys(u)
  eq((await ingestEvents(token, [sessionEvent(`s2-${u}`)])).status, 403, "blocked")
})

await check("ingest-token: a token from an ended session cannot write history", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  const row = await sandboxRow(ws.id)
  const token = m.ingest.mintIngestToken(u, ws.id, 60_000, row.lastSessionStartedAt.getTime())
  await m.sandbox.stopWorkspace(u, ws.id)
  m.keys.forgetRelayKeys(u)
  eq((await ingestEvents(token, [sessionEvent(`s-${u}`)])).status, 401, "ended session")
})

await check("workspace: a deleted workspace's token cannot write, and its VM is destroyed even when the first delete fails", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  const row = await sandboxRow(ws.id)
  const token = m.ingest.mintIngestToken(u, ws.id, 60_000, row.lastSessionStartedAt.getTime())
  const name = `ws_${ws.id.toLowerCase()}`
  vms().get(name).failDelete = true
  as(u, `${u}@test`)
  eq((await json(await m.wsRoute.DELETE(new Request("http://t", { method: "DELETE" }), ctx({ id: ws.id })))).status, 200, "delete")
  m.keys.forgetRelayKeys(u)
  eq((await ingestEvents(token, [sessionEvent(`s-${u}`)])).status, 401, "deleted workspace")
  ok(vms().has(name), "VM survived the failed delete (test setup)")
  vms().get(name).failDelete = false
  await m.cron.GET(new Request("http://t/api/cron/daily", { headers: { authorization: "Bearer cron-secret" } }))
  eq(vms().has(name), false, "cron retried the VM delete")
})

await check("workspace: an open in flight when the workspace is deleted does not leave a VM behind", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  const name = `ws_${ws.id.toLowerCase()}`
  const g = gate()
  globalThis.__createGate = g.p
  const opening = m.sandbox.openWorkspace(u, ws.id, { exempt: true }).then(
    () => "opened",
    (e) => `refused: ${e.message}`,
  )
  await sleep(50)
  as(u, `${u}@test`)
  eq((await json(await m.wsRoute.DELETE(new Request("http://t", { method: "DELETE" }), ctx({ id: ws.id })))).status, 200, "delete")
  globalThis.__createGate = undefined
  g.open()
  ok((await opening).startsWith("refused"), "open refused")
  eq(vms().has(name), false, "VM destroyed")
  ok((await sandboxRow(ws.id)).vmDeletedAt, "vm_deleted_at set")
})

// ================================================================ sm-syrup-skills

await check("skills: a reload deferred because a turn was running is done by the next heartbeat once the engine is idle", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  await admin().update(S.sandboxes).set({ skillsReloadDueAt: new Date() }).where(sql`workspace_id = ${ws.id}`)
  await m.sandbox.heartbeat(u, ws.id, { exempt: true })
  eq((await sandboxRow(ws.id)).skillsReloadDueAt, null, "reload done")
})

// ================================================================ sm-syrup-consent

await check("consent: granting twice keeps one live row; signing in on an outdated version records the current one", async () => {
  const u = await newUser()
  await m.legal.recordConsent(u, ["research"], { ipHash: null, userAgent: null })
  await m.legal.recordConsent(u, ["research"], { ipHash: null, userAgent: null })
  const live = await admin().select().from(S.consents).where(sql`user_id = ${u} and kind = 'research' and revoked_at is null`)
  eq(live.length, 1, "live research rows")
  const [old] = await admin().insert(S.legalDocuments).values({ id: `old-privacy-${u}`, kind: "privacy", version: `1999-01-0${n % 9}`, contentHash: "x" }).returning()
  await admin().insert(S.consents).values({ id: `c-${u}`, userId: u, legalDocumentId: old.id, kind: "privacy" })
  await m.legal.consentAtSignIn(u, { ipHash: null, userAgent: null })
  const now = await m.legal.currentConsents(u)
  eq([now.privacy.current, now.terms.current], [true, true], "terms and privacy current after sign-in")
})

// ================================================================ sm-syrup-chat-session / sm-syrup-message

await check("chat-session: a late batch does not add messages to a deleted chat", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.history.applyEvents(u, ws.id, [sessionEvent(`cs-${u}`), { type: "session.deleted", properties: { info: { id: `cs-${u}` } } }])
  await m.history.applyEvents(u, ws.id, [{ type: "message.updated", properties: { info: { id: `m-${u}`, sessionID: `cs-${u}`, role: "assistant" } } }])
  const rows = await admin().select().from(S.messages).where(sql`session_id = ${`cs-${u}`}`)
  eq(rows.length, 0, "messages in a deleted chat")
})

await check("message: an older part update cannot overwrite a finished one", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  const part = (status) => ({ type: "message.part.updated", properties: { part: { id: "p1", messageID: `m-${u}`, sessionID: `cs-${u}`, type: "tool", state: { status } } } })
  await m.history.applyEvents(u, ws.id, [part("completed"), part("running")])
  const [row] = await admin().select().from(S.messages).where(sql`id = ${`m-${u}`}`)
  eq(row.parts.p1.state.status, "completed", "part status")
})

await check("message: when an engine session ends, its unfinished replies are marked interrupted", async () => {
  const u = await newUser()
  const ws = await newWorkspace(u)
  await m.sandbox.openWorkspace(u, ws.id, { exempt: true })
  await m.history.applyEvents(u, ws.id, [
    { type: "message.updated", properties: { info: { id: `m-${u}`, sessionID: `cs-${u}`, role: "assistant", time: { created: Date.now() } } } },
    { type: "message.part.updated", properties: { part: { id: "p1", messageID: `m-${u}`, sessionID: `cs-${u}`, type: "tool", state: { status: "running" } } } },
  ])
  await m.sandbox.stopWorkspace(u, ws.id)
  // The engine's own copy still says in progress; a resync after a restart replays it.
  await m.history.applyEvents(u, ws.id, [
    { type: "message.updated", properties: { info: { id: `m-${u}`, sessionID: `cs-${u}`, role: "assistant", time: { created: Date.now() } } } },
    { type: "message.part.updated", properties: { part: { id: "p1", messageID: `m-${u}`, sessionID: `cs-${u}`, type: "tool", state: { status: "running" } } } },
  ])
  const [row] = await admin().select().from(S.messages).where(sql`id = ${`m-${u}`}`)
  ok(row.completedAt, "completed_at set")
  eq(row.info?.error?.name, "MessageInterruptedError", "error")
  eq(row.parts.p1.state.status, "error", "running tool part")
})

// ================================================================ sm-syrup-memory

await check("memory: a forgotten memory can be restored, and the cron purges ones forgotten long ago", async () => {
  const u = await newUser()
  const store = m.memory.pgMemoryStore(u)
  const a = await store.save({ title: "a", content: "a" })
  const b = await store.save({ title: "b", content: "b" })
  await store.delete(a.id)
  await store.delete(b.id)
  await m.memory.restoreMemory(u, a.id)
  ok(await store.get(a.id), "restored")
  await admin().update(S.memories).set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) }).where(sql`id = ${b.id}`)
  await m.cron.GET(new Request("http://t/api/cron/daily", { headers: { authorization: "Bearer cron-secret" } }))
  eq((await admin().select().from(S.memories).where(sql`id = ${b.id}`)).length, 0, "purged")
})

console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(failed ? 1 : 0)
