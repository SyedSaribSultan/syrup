# Phase 2 — the agent in a sandbox

**Goal:** a signed-in user creates a workspace from a Git URL, opens it, and chats with the full OpenCode agent running in an isolated Vercel Sandbox, with syrup's router and memory beside it, keys never on disk, sessions resuming across the 45-minute cap. Same chat UI as local mode.

**Facts this plan rests on (verified 2026-09-24):** `@vercel/sandbox` v2: `Sandbox.getOrCreate({ name, image, ports, resources, timeout, networkPolicy, env, onCreate, onResume })`, `sandbox.domain(port)`, `runCommand({ detached, env, cwd })`, `writeFiles`, `extendTimeout`, `stop()` auto-snapshots; images `vercel/sandbox/universal` and `vercel/sandbox/node:24`; Hobby: 10 concurrent, 45-minute sessions, 5 CPU-hours/month. OpenCode: `serve --hostname --port --cors <origin>`, `OPENCODE_SERVER_PASSWORD` basic auth, `OPENCODE_CONFIG_CONTENT` env for config without a file.

## 1. Architecture (final)

```
Browser ─────────────── HTTPS + Basic auth (per-sandbox password, in memory) ──▶ sb-<id>.vercel.run:4096
   │                                                                              OpenCode serve  --cors https://syrup.syedsarib.com
   │  /api/workspaces/*  (create, list, open → connection info, heartbeat, stop)    │  provider "syrup" → http://127.0.0.1:4210/v1
   ▼                                                                                │  mcp "syrup"      → http://127.0.0.1:4210/mcp
syrup app (Vercel)  ── @vercel/sandbox (OIDC) ──▶ Sandbox "ws_<workspaceId>"       ▼
   │  /api/ingest  ◀── bearer (HMAC token: user, workspace, exp) ──────────── sidecar :4210 (loopback only)
   ▼                                                                             router · memory MCP · event tap
Neon Postgres (RLS): workspaces, sandboxes, chat_sessions, messages, router_events, usage_events, memories
```

- **Only port 4096 is public.** The sidecar listens on loopback inside the VM; only OpenCode reaches it.
- **Keys** are decrypted at resume and passed as **process env** to the sidecar. Nothing secret is ever written to the sandbox filesystem, so snapshots are clean.
- **The sidecar reports back** over HTTPS to `/api/ingest` with a short-lived token. Postgres is the source of truth for history; the sandbox is disposable.
- **OpenCode's own state** (`~/.local/share/opencode`) lives on the sandbox disk and survives via snapshots, so resuming continues the same session.

## 2. How this gets built fast and clean

**Principles**
1. **Interfaces before implementations.** The local engine and the sandbox engine implement one `Engine` contract. The router and memory server take a `Store` interface with two implementations (SQLite locally, HTTP ingest in the sandbox). No `if (isCloud)` inside business logic; the branch happens once, at composition.
2. **Pure core, thin I/O.** `router/backends.ts` and the request loop stay pure; what changes is where keys come from and where events go.
3. **One bundle, no node_modules in the sandbox.** The sidecar is built with esbuild into a single `sidecar.js` (~300 KB) at `next build` time and uploaded with `writeFiles`. Boot is one `node` command.
4. **Verify against the installed SDK, not memory.** Every SDK call is checked in `node_modules/@vercel/sandbox/dist/*.d.ts` before it is written. Same for OpenCode config keys in `@opencode-ai/sdk`.
5. **Slices with gates.** Seven slices; each ends with `tsc`, `eslint`, `next build`, a scripted check, a commit, a deploy. Nothing moves to the next slice while the gate is red.
6. **Fail closed, log everything.** `slog()` on every lifecycle step with `userId`/`workspaceId`; the Logs modal shows them. A `agent_enabled` kill switch (PostHog flag + env override).
7. **Zod on every request body, RLS on every new table, `withUser()` on every tenant query.** Migration files for every schema change; never edit the DB by hand.
8. **Rollback is `git revert` + redeploy.** Sandboxes are disposable; the database is the only stateful thing and only gains tables.

**Repository layout added**
```
sidecar/                     # runs inside the sandbox
  index.ts                   # boot: parse env, start router + MCP, start event tap
  store-http.ts              # Store implementation → /api/ingest
  build.mjs                  # esbuild → .sidecar/sidecar.js (run in `prebuild`)
src/server/router/core.ts    # pure request loop (moved out of server.ts)
src/server/router/store.ts   # Store interface
src/server/router/store-sqlite.ts
src/server/memory/core.ts    # memory tools over a MemoryStore
src/server/engine/types.ts   # Engine contract
src/server/engine/sandbox.ts # SandboxEngine: create/resume/stop/connect
src/server/cloud/workspaces.ts
src/server/cloud/ingest.ts   # token mint/verify + writers
src/app/api/workspaces/…     # REST
src/app/api/ingest/route.ts
src/app/w/[id]/…             # workspace pages (chat lives here in cloud)
```

## 3. Slices

### S1 — Sandbox lifecycle (1 day) ✅ 2026-09-24 — cold 8.6–9.5 s, warm resume 6.6 s, hot 0.4 s; universal image, HOME=/vercel, ~7–10 CPU-s per boot
- `sandboxes` + `workspaces` tables (migration 0002, RLS forced).
- `SandboxEngine.ensure(workspace)`: `getOrCreate({ name: ws_<id>, image: universal, ports: [4096], resources: { vcpus: 1 }, timeout: 10 min, networkPolicy })`. `onCreate`: install OpenCode (official installer), clone repo. `onResume`: rotate password, start OpenCode with `OPENCODE_CONFIG_CONTENT`, `--cors`.
- Admin-only debug route `/api/admin/sandbox/probe` that boots one and hits `/global/health` with the password. Measures cold boot and resume times; decides `universal` vs `node:24`.
- **Gate:** probe returns OpenCode's version; sandbox appears in the Vercel dashboard; stop() snapshots; second probe resumes in under ~10 s.

### S2 — Sidecar (1.5 days) ✅ 2026-09-24 — router core + memory tools shared with local mode; prompt via syrup/auto answered through the user's key; MCP connected; sidecar 1.4 MB single file
- Extract `router/core.ts` and `memory/core.ts` behind `Store`/`MemoryStore`. Local mode keeps working through `store-sqlite.ts` (regression check: local chat, router failover, memory tools).
- `sidecar/index.ts` + esbuild build wired into `prebuild`. Uploaded on create and re-uploaded on resume if the hash changed.
- Started detached with env: `SYRUP_KEYS` (JSON of active keys), `SYRUP_INGEST_URL`, `SYRUP_INGEST_TOKEN`, `SYRUP_INTERNAL_SECRET`. OpenCode config points provider + MCP at `127.0.0.1:4210` with that secret. `lsp` disabled in cloud config (verify key name in SDK types).
- **Gate:** inside the sandbox, `curl 127.0.0.1:4210/v1/models` lists `syrup/auto`; OpenCode `/mcp` shows `syrup: connected`; a prompt through the probe route gets a model answer routed via the user's Google key.

### S3 — Ingest and history (1 day)
- Tables: `chat_sessions`, `messages`, `router_events`, `usage_events` (cloud) — migration 0003, RLS forced.
- `/api/ingest`: verifies the HMAC token (user, workspace, sandbox, exp ≤ 1 h), batches rows, writes under `withUser()`. Sidecar event tap subscribes to OpenCode's `/global/event` and forwards session/message/part updates; router posts its events.
- Chats list and usage dashboard read from Postgres (no sandbox boot to browse history).
- **Gate:** after a probe prompt, rows exist for the user and none are visible under another user id.

### S4 — Browser talks to the sandbox (1 day)
- `/api/workspaces/:id/open` → ensures the sandbox, returns `{ baseUrl, authHeader, directory, expiresAt }`. Password lives only in the browser's memory (engine-store state), never in localStorage.
- `oc()` gains a connection parameter; `EngineProvider` takes `{ baseUrl, headers, directory }` from the workspace page instead of `/api/oc`. Event stream fetch sends the header. CORS preflight verified against `--cors`.
- **Gate:** the existing chat UI streams a reply from the sandbox on syrup.syedsarib.com; permissions and questions round-trip.

### S5 — Workspaces UI (1 day)
- `/workspaces` list, "New workspace" (public Git URL or empty), open, rename, delete (stops + deletes sandbox and snapshots). Private GitHub repos via a **fine-grained PAT** stored encrypted per user (GitHub App/OAuth later).
- Home shows workspaces; sidebar shows recent chats for the open workspace; local-mode folder picker hidden.
- **Gate:** create from `https://github.com/SyedSaribSultan/sarib-lang`, open, ask the agent to summarise the repo.

### S6 — Lifecycle polish (1 day)
- Heartbeat every 60 s from an open workspace tab → `/api/workspaces/:id/heartbeat` → `extendTimeout` when < 5 min remain, capped at the 45-minute session. No heartbeat ⇒ the VM stops by itself within 10 minutes (no cron needed).
- States in the UI: `starting` (cold, with progress log lines), `waking` (resume), `running`, `stopped`, `error` with the real reason. Automatic re-`open` when a request hits a stopped sandbox.
- 45-minute rollover: detect session end, resume, reconnect the event stream, continue the OpenCode session.
- **Gate:** leave a tab idle 12 minutes → sandbox stopped in dashboard; type a message → wakes and answers; force a 45-minute boundary with a short timeout in a test → conversation continues.

### S7 — Hardening and observability (1 day)
- Egress allow-list per workspace: defaults from the user's providers + GitHub + npm/pypi registries + the ingest host; one-click add from an error toast.
- Password rotated every resume; `sandboxes.password_enc` under the user's DEK; ingest tokens expire hourly.
- PostHog events: `workspace_created`, `sandbox_started` (cold/warm, ms), `sandbox_stopped` (seconds, CPU ms from `stop()`), `message_sent` (alias, tokens bucket), `sandbox_error` (type). Admin page: sandbox pool view (running now, minutes today, CPU-ms), per-user usage (informational).
- Kill switch, docs (ARCHITECTURE/PLAN/SETUP), Phase 3 handoff notes.
- **Gate:** security checklist from PLAN §4 walked; `next build` clean; a fresh user (second Google account, invited) can do the whole flow.

**Total: ~7.5 working days.** Order is fixed; S1–S3 are server-only and testable without touching the UI.

## 4. Risks and the pre-decided answer

| Risk | Answer |
|---|---|
| Cold boot slow (installer + clone) | Measure in S1. If > 60 s, publish a custom image with OpenCode preinstalled (Vercel Container Registry, free within limits) in S7. |
| CORS blocks `Authorization` preflight | `--cors https://syrup.syedsarib.com` plus preview origin; if OpenCode's CORS omits the header, fall back to a same-origin `/api/ws/:id/*` streaming proxy (Vercel functions can stream SSE up to 300 s; reconnect handles the rest). |
| Snapshot quota (15 GB) | `keepLastSnapshots: { count: 1 }`, 7-day expiry, `node_modules` excluded by running installs into a tmpfs path. |
| 5 CPU-hours/month | LSP off, idle stop at 10 min, 1 vCPU. Admin shows CPU-ms per sandbox from `stop()`. |
| Keys visible in `ps` inside the VM | Only the user's own agent runs in that VM; acceptable and documented. Egress allow-list limits exfiltration targets. |
| OpenCode version drift | Pin the installer version; record it in `sandboxes.engine_version`. |

## 5. Definition of done

A second invited Google account can: sign in → add a key → create a workspace from a public repo → chat with the agent, see tool calls and permissions → close the tab → come back next day → continue the same chat → see the session's cost in Usage → delete the workspace. Their rows are invisible to the admin's `withUser()` scope; the admin page shows aggregate usage only.
