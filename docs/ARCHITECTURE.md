# Architecture

## Goals

- Strongest practical coding agent without a single subscription.
- Users bring their own API keys. Free tiers first, paid when the task deserves it.
- Every token accounted for. Spend is visible, never a surprise.
- Self-hosted, single user in v1. Data model leaves room for multi-user later.
- No local models.

## Components

```
┌────────────────────────────────────────────────────────────┐
│  Browser                                                   │
│  Next.js app: sessions, chat, diffs, permissions,          │
│  terminal, files, key vault, cost dashboard                │
└──────────────────────────┬─────────────────────────────────┘
                           │ HTTP + SSE
┌──────────────────────────▼─────────────────────────────────┐
│  syrup server (Next.js route handlers, Node)               │
│                                                            │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────┐  │
│  │ engine       │  │ ledger        │  │ vault           │  │
│  │ OpenCode SDK │  │ usage + cost  │  │ provider keys   │  │
│  │ + SSE relay  │  │ per message   │  │ (encrypted)     │  │
│  └──────┬───────┘  └───────────────┘  └─────────────────┘  │
│         │           ┌───────────────┐  ┌─────────────────┐  │
│         │           │ router        │  │ memory          │  │
│         │           │ /v1/chat/...  │  │ MCP server      │  │
│         │           │ failover, RL  │  │ long-term store │  │
│         │           └───────────────┘  └─────────────────┘  │
│                       SQLite (libsql) via Drizzle          │
└─────────┼──────────────────────────────────────────────────┘
          │ spawns + drives
┌─────────▼──────────────────────────────────────────────────┐
│  OpenCode server (`opencode serve`)                        │
│  agent loop, tools, LSP, MCP, skills, compaction,          │
│  sessions, permissions, questions, PTY, VCS diff           │
└─────────┬──────────────────────────────────────────────────┘
          │ provider SDKs (Vercel AI SDK); Auto/Fast via the router
┌─────────▼──────────────────────────────────────────────────┐
│  Providers: Google AI Studio, NVIDIA, OpenRouter, Mistral, │
│  Groq, Z.ai, any OpenAI-compat. OpenCode Zen (free) is     │
│  a direct pick only; the router never sends to it.         │
└────────────────────────────────────────────────────────────┘
```

## Why OpenCode as the engine

- Most-starred open-source coding agent (~200k), MIT, active.
- Built as client/server. `opencode serve` exposes an OpenAPI 3.1 spec, a TS SDK (`@opencode-ai/sdk`) and SSE events. Custom front ends are a supported use.
- Provider-agnostic through the Vercel AI SDK. Model catalog from models.dev with per-token prices, context limits and modality flags.
- Already tracks `cost` and `tokens` (input, output, reasoning, cache read/write) on every assistant message and rolled up per session. The ledger reads this, it does not estimate.
- Native Agent Skills (`SKILL.md`), MCP, Plan/Build agents, subagents, LSP diagnostics, auto-compaction.

The engine sits behind one interface (`src/server/engine`). If OpenCode ever becomes a blocker, OpenHands SDK is the fallback.

## What syrup adds on top

| Concern | OpenCode has | syrup adds |
|---|---|---|
| UI | TUI, basic web | Full web app |
| Keys | One key per provider in `auth.json` | Vault with many keys per provider, labels, free/paid flag |
| Routing | Pick one model | Router: best model per chat from your keys, sticky per session, per-model cooldowns, invisible failover before the first token |
| Cost | Per message/session numbers | Ledger, dashboard, budgets, free-vs-paid split, per provider/day |
| Memory | `AGENTS.md`, session history | Long-term memory store exposed as MCP tools |
| Skills | Loads `SKILL.md` | Browse, install, enable from the UI |

## Router

The router (`src/server/router`) is an OpenAI-compatible server registered in OpenCode as the `syrup` provider with two aliases, `syrup/auto` and `syrup/fast`. The same core runs in-process locally and inside the cloud sandbox sidecar (`sidecar/`). The research behind it: gains come from plumbing (feasibility, cooldowns, deadlines, stickiness, measured health), not from an LLM classifier. Switching models mid-session costs quality and kills prompt caching.

- **Candidates.** Every model the engine catalog lists (OpenCode `provider.list`, models.dev data) for a provider the router can reach (one with an OpenAI-compatible base URL in `backends.ts`) and holds a key for: the active vault key, or in local mode the provider's environment variable (except paid-only providers such as Anthropic and OpenAI, so a stray `ANTHROPIC_API_KEY` never spends money through Auto). Anthropic is reached through its OpenAI-compatible endpoint. The catalog lists models an account may not have (Mistral's free plan has no GLM-5.3 or Large), so each key's own `GET /models` list is fetched on first use and hourly (`served.ts`) and unserved models are dropped; an unreadable list, or one matching no catalog id, filters nothing. In the cloud the sidecar refreshes keys every minute, and right after a rejected key, from `GET /api/ingest/keys` (authorised by the sandbox's ingest token), so a key added mid-session applies without a restart. OpenCode Zen is never a candidate: its free tier answers 403 "can only be used from within OpenCode" to proxied requests, so Zen models are direct picks only. The Providers page marks other providers the router cannot reach as direct picks too. A key tagged free only yields the models that provider's free tier serves (`buildCandidates`), so a new key defaults to paid unless the curated entry says the provider has a free tier. What syrup knows beyond the catalog lives in `src/lib/model-registry.ts`: a 0–100 coding-agent quality score, speed priors (tokens/s, time to first token), free-tier capacity per model, and which models matter for an agent at all. The model picker reads the same module.
- **Feasibility filter.** Candidates that cannot take the request are dropped before scoring: not usable by an agent (not chat, no tool calling, deprecated, small context), prompt plus output budget larger than the context window or the free tier's tokens-per-minute limit (the output budget is clamped first, so e.g. Groq's 8K TPM still serves tiny requests), image input on a model without vision, one-request-at-a-time providers already busy, or cooling down. A context-length rejection teaches the router a prompt cap for that backend, which expires after an hour. Tool support is read from the catalog's `capabilities.toolcall`.
- **Scoring.** Each remaining candidate gets a score from quality, predicted time (registry priors, replaced by measured time to first token and tokens/s as requests come in; the measurements decay back toward the priors with a 10-minute half-life, so one bad minute does not demote a model for good), error rate, scarcity (a free tier with ~20 requests/day is saved for hard turns) and cost. **Free first:** a paid key wins only when no good free model (quality 70+, or 84+ on a hard turn) can take the turn. **Auto** favours quality; **Fast** favours predicted time and asks for low thinking effort. A turn is hard when the user asks to plan, debug, design or investigate, or after two tool results in a row that start with an error.
- **Stickiness.** OpenCode sends the session id on every model request (`x-session-affinity`, `X-Session-Id`; `x-parent-session-id` for subagents). The router keeps a session on the model it started with, so prompt caches stay warm and behaviour does not drift. It lets go only when needed: the model is unavailable, a hard turn needs a stronger grade, a scarce free model reaches a new routine user turn, the model became far slower, the session landed there only through a failover (or on a paid key) and the better free backend is back, or a new user turn has a clearly better model on offer. Tool-call continuations stay put.
- **Cooldowns per model, by limit type.** Most failures cool down only that provider/model on that key: Google quotas are per model, and one overloaded model must not bench the rest. Two cases reach wider. A rejected key (401/403) or payment required (402) cools down every model on that key. OpenRouter's daily free-model cap cools down every $0 model on that account. The reason decides how long: per-day limit (until the reset, e.g. midnight Pacific for Google), per-minute limit (the provider's retry delay; Google 429 bodies carry `QuotaFailure` with `PerDay`/`PerMinute` quota ids and `RetryInfo.retryDelay`), overloaded (503), rejected key (401/403, recorded as an auth failure for the provider), timeout, or other error.
- **First-token commit.** The router sends nothing to OpenCode until the chosen backend produces its first token, within a deadline. If the backend errors or misses the deadline first, the router moves to the next candidate and the client never sees the failure. Once a byte is sent, the request is committed to that backend.
- **Status API.** Every attempt is a row in `router_events` (now with session id, time to first token, retry-at and reason). `GET /api/router/status` derives per-backend health (cooldown and reason, median time to first token, success rate), the model each alias last answered with, and providers whose key was rejected in the last hour. `GET /api/router/answers` lists which model answered each request in a chat. Shapes live in `src/lib/router-status.ts`, so local and cloud read the same thing; the Providers page uses it to flag a rejected key.

**Token efficiency.** `syrupEngineConfig` (`src/server/engine/opencode.ts`, shared by local mode and the sandbox) turns on OpenCode's tool-output pruning (`compaction: { auto: true, prune: true }`; masking old tool outputs costs about half the tokens with equal or better solve rates) and declares the aliases with a 256K context and 32K output. That keeps prompts within reach of the strong free models (mostly 200K–1M windows) and makes OpenCode compact before prompts get slow.

## Phasing

**Phase 1 — drive OpenCode from the browser.** ✅ Spawn `opencode serve`, relay SSE, render sessions and streaming messages, handle permissions and questions. Ledger reads cost/tokens from OpenCode messages.

**Phase 2 — key vault + router.** ✅ Vault: many encrypted keys per provider with a free/paid tier; the active one is written into OpenCode auth. Router: an in-process OpenAI-compatible server (port 4210) registered in OpenCode as the `syrup` provider with `syrup/auto` and `syrup/fast`. It resolves an alias to ranked backends from the user's connected keys (free tiers first), injects the key, fails over on 429/5xx with per-key cooldowns, and logs every attempt with real cost to `router_events`. OpenCode Zen free models cannot be routed (they only accept requests from OpenCode itself); they remain selectable directly. Since superseded by the routing described under [Router](#router): per-model cooldowns, session stickiness and first-token failover.

**Phase 3 — memory + skills.** ✅ Memory: `memories` table with an FTS5 index (no embedding model needed), a Streamable HTTP MCP server on the router port exposing `memory_search/list/get/save/update/forget`, and a generated `data/memory/MEMORY.md` loaded as engine instructions so the agent always sees its index. Skills: list from the engine, create from pasted `SKILL.md`, install from GitHub (packs supported) into `~/.config/opencode/skills`, remove.

**Phase 4 — product completeness.** ✅ Workspaces (per-folder sessions, native OS folder dialog, typed paths, recents), session rename/delete, attachments (images/files as data URLs), Changes panel (engine snapshot diff, falling back to files touched by write/edit tools), first-run banner, production build verified.

**Logs.** ✅ `slog()` writes structured events (level, source, event, session, directory, redacted JSON) to the `logs` table in batches, so hot paths never wait on SQLite. A Logs modal, opened from the sidebar, shows them app-wide by default and copies a debugging bundle.

**Folder dialog.** The server opens the OS dialog on its own desktop (self-hosted, so browser and server share one). Windows: the modern Explorer picker (`IFileOpenDialog`, folder mode) called over COM from Windows PowerShell 5.1, owned by an invisible TopMost window so it opens in front. macOS: `osascript choose folder`. Linux: `zenity`, then `kdialog`. One dialog at a time; a new request replaces a stuck one; 3-minute timeout.

**`.sarib` (optional).** `src/server/sarib.ts`. The `sarib` MCP server is added per workspace, and only to folders with a `.sarib` file within three levels (dependency and build folders skipped; rescanned at most once a minute). The OpenCode proxy triggers the check on any request with a `directory`, and waits for it (up to 5 s) before a prompt so that turn already has the tools. OpenCode keeps MCP state per directory and runs local servers there, so the server sees only that workspace. Other workspaces never pay for its tool definitions. Needs Python 3.10+ and `sarib[mcp]`; the Skills page has an **Enable** button that runs `pip install --user "sarib[mcp]"` in the background (`/api/sarib`).

**Two modes (2026-09-24).** `SYRUP_MODE=local|cloud` (auto: cloud on Vercel) in `src/server/env.ts`. Everything above is local mode. Cloud mode is the hosted product at syrup.syedsarib.com, designed in [PLAN.md](PLAN.md): Google sign-in (Auth.js v5, JWT sessions, open to any verified Google account), Neon Postgres with forced row-level security (`src/server/db/pg`, every tenant query inside `withUser()`), per-user envelope-encrypted provider keys (`src/server/cloud`), legal documents with recorded consent, PostHog analytics with opt-out, admin page. The agent itself (a Vercel Sandbox per workspace) is Phase 2; until then cloud mode blocks the local-engine routes with 501 in `src/proxy.ts`.

**Local hardening (Phase 0, 2026-09-24).** Server binds 127.0.0.1; `src/proxy.ts` rejects non-loopback Host and cross-origin mutations; the OpenCode server runs with a per-process password that only the `/api/oc` proxy and server modules know; router and memory MCP require the same secret as bearer; the vault key lives in the user config dir, outside any workspace.

**Cloud runtime (Phase 2, 2026-09-24).** One Vercel Sandbox per workspace (`src/server/engine/sandbox.ts`): universal image, fra1, 1 vCPU, 10-minute idle timeout extended by a heartbeat while the tab is visible, last snapshot kept 7 days. On create: OpenCode 1.18.32 pinned + repo clone (private GitHub via a one-shot credential helper reading process env). On every start: the esbuild-bundled **sidecar** (`sidecar/`, the same router core and memory tools as local mode) is uploaded and started with the user's keys, an ingest token and a per-start secret in process env; OpenCode is started with a per-start password and a config pointing its `syrup` provider and memory MCP at the sidecar on loopback. Only OpenCode's port is public; the browser connects to it directly with Basic auth held in memory (`src/lib/oc.ts`, `EngineProvider` connection). The sidecar taps OpenCode's event bus and posts sessions, messages, router attempts, memory ops and logs to `/api/ingest/*` with a 2-hour HMAC token bound to user + workspace; Postgres is the history, the sandbox is disposable. Egress: private networks and the metadata service always denied; a workspace with listed hosts runs a strict allow-list. Kill switch `SYRUP_AGENT_ENABLED=0`. Measured: cold 9–15 s, warm resume 7 s, hot 0.3 s, ~7–25 CPU-seconds per boot-and-prompt.

**Home workspace (2026-09-28).** Every user has a workspace named Home that needs no setup, is listed first with color 0, cannot be removed, counts toward the cap of 8, and is where new chats start. Local: the folder `~/syrup` (`%USERPROFILE%\syrup`), created by `GET /api/workspace/home`; a first visit (no saved folder) opens it, and an existing full list makes room by dropping its least recently used folder (chats stay on disk). Cloud: a `workspaces` row with `is_home` (migration 0009), created by `ensureHome()` on the first list or visit to `/`; the partial unique index `workspaces_home_idx` plus `insert … on conflict do nothing` keeps it to one per user under concurrent requests, and `DELETE /api/workspaces/:id` refuses it. `/` redirects to Home. Opening a sandbox never blocks the UI: the app prewarms Home's sandbox on load, `src/lib/home.ts` shares the in-flight open with the workspace view, the `/w/[id]` layout keeps one connection across the new-chat screen and chats, and `createSession`/`send` in `EngineProvider` wait for the engine, so a message typed early shows as pending and goes out when it connects.

**Later.** Terminal (PTY endpoints exist), budgets and alerts, theme toggle, mobile layout, teams/organizations, exports to R2 with email.

## Known issues

- ✅ Router verified with a real Google key (2026-09-23): a tool-calling turn hit a 503 on `gemini-3.8-flash`, failed over to `gemini-3.5-flash-lite`, and the follow-up turn (which needs the Gemini thought signature restored) succeeded on `gemini-3.8-flash`.
- Gemini 3.8 Flash on the free tier returns 503 "high demand" and 429 often. Observed before the router rewrite: one 503 put the whole Google key into cooldown, Gemini 3.5 Flash-Lite averaged 49 s to first byte, and one failed attempt hung 31 s with no deadline. Per-model cooldowns and the first-token deadline address these.
- ✅ Fixed 2026-10-07: a workspace folder that was moved or deleted. The engine accepted the session and failed the first prompt with a bare "Unexpected server error". The local proxy (`/api/oc`) now answers 404 with a plain sentence for any request naming a missing `directory`; the workspace list probes its folders on load (`/api/workspace?probe=1`), marks a missing one "Folder not found" in the switcher and moves the app to Home if it was the open one; a refused prompt or session create now shows its message in the chat instead of nothing.
- ✅ Fixed 2026-10-07: the Changes panel was always empty. Two causes. (1) OpenCode 1.18 keeps diffs per user message (`info.summary.diffs`, a full-context unified `patch` per file, written after the turn settles); `GET /session/{id}/diff` answers `[]` without a user `messageID`, and syrup asked without one. The panel now reads the summaries already in the message store (no request at all) and merges turns per file (`src/lib/diffs.ts`, tested by `scripts/test-diffs.mjs`): first-before against last-after, so a line edited three times counts once. (2) The engine snapshots only git worktrees, so Home (`~/syrup`) and empty cloud workspaces never had diffs or revert. Home gets `git init` (no commits) when created or first visited; cloud empty workspaces get it at create, and existing sandboxes catch up on their next start. Other non-git folders say so in the panel.
- ✅ Fixed 2026-10-07: duplicate skill names. The engine lists one copy per name and may switch after a reload, so a skill seemed to vanish. `listSkills` now scans every root the engine reads (`~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, and `.opencode|.claude|.agents/skills` in the workspace) and reports the other copies per skill; the Skills page shows a notice and the paths. The engine still decides which copy loads; the user keeps one.
- OpenCode Zen free models cannot be routed by syrup: the free tier answers 403 "can only be used from within OpenCode" to proxied requests (observed live). They remain selectable directly in the model picker; Auto and Fast never use them.

## Data (SQLite via Drizzle)

- `provider_keys` — provider id, label, encrypted key, tier (free/paid), rate-limit hints, enabled.
- `usage_events` — one row per assistant message: session, message, provider, model, tokens, cost, timestamp, key used.
- `router_events` — one row per routed request: alias, provider, model, key, tier, status, attempts, latency, time to first token, tokens, real cost, error, session id, retry-at and reason. Source for the router status API.
- `memories` — id, kind, content, embedding, tags, source session, timestamps.
- `logs` — structured application log: timestamp, level, source, event, session, directory, redacted JSON data.
- `settings` — key/value.

OpenCode keeps its own session and message storage. syrup does not duplicate it; the ledger keys off OpenCode message ids.

## Free tier notes (as of Sept 2026, verify before trusting)

- OpenCode Zen: free models with no key (Big Pickle, Muse Spark 1.3, MiMo-V2.6-Flash, Space Bunny, Nemotron 3 Ultra and more). Direct picks only; the router can't use them. Free for a limited time; some train on prompts.
- Google AI Studio: per-model, per-project quotas. Gemini 3.x Flash ~20 req/day, Flash-Lite ~500/day, Pro not on the free tier (since Apr 2026). Resets midnight Pacific. Free tier may train on prompts.
- NVIDIA NIM: ~40 req/min, no published daily cap. Development and evaluation use.
- OpenRouter `:free`: 20 req/min, 50 req/day shared across the whole account (1,000 after a one-time $10 purchase).
- Mistral free plan: $10 of API credits per month. Turn off training in Privacy settings.
- Z.ai: GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash free, one request at a time.
- Cohere trial: 1,000 calls/month, non-commercial.
- Groq free: 8K tokens/min. A 50K-token agent turn is rejected outright; side tasks only.
- Cerebras: no free tier. $5 trial with a card, 30K tokens/min.
- Free usually means prompts may train the model. The UI must say so per provider.
