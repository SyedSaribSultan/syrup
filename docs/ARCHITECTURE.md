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
          │ provider SDKs (Vercel AI SDK)
┌─────────▼──────────────────────────────────────────────────┐
│  Providers: Google AI Studio, Groq, Mistral, OpenRouter,   │
│  Cerebras, NVIDIA, OpenCode Zen (free), any OpenAI-compat  │
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
| Routing | Pick one model | Router: rate-limit aware, fails over across keys and providers, prefers free tiers |
| Cost | Per message/session numbers | Ledger, dashboard, budgets, free-vs-paid split, per provider/day |
| Memory | `AGENTS.md`, session history | Long-term memory store exposed as MCP tools |
| Skills | Loads `SKILL.md` | Browse, install, enable from the UI |

## Phasing

**Phase 1 — drive OpenCode from the browser.** ✅ Spawn `opencode serve`, relay SSE, render sessions and streaming messages, handle permissions and questions. Ledger reads cost/tokens from OpenCode messages.

**Phase 2 — key vault + router.** ✅ Vault: many encrypted keys per provider with a free/paid tier; the active one is written into OpenCode auth. Router: an in-process OpenAI-compatible server (port 4210) registered in OpenCode as the `syrup` provider with `syrup/auto` and `syrup/fast`. It resolves an alias to ranked backends from the user's connected keys (free tiers first), injects the key, fails over on 429/5xx with per-key cooldowns, and logs every attempt with real cost to `router_events`. OpenCode Zen free models cannot be routed (they only accept requests from OpenCode itself); they remain selectable directly.

**Phase 3 — memory + skills.** ✅ Memory: `memories` table with an FTS5 index (no embedding model needed), a Streamable HTTP MCP server on the router port exposing `memory_search/list/get/save/update/forget`, and a generated `data/memory/MEMORY.md` loaded as engine instructions so the agent always sees its index. Skills: list from the engine, create from pasted `SKILL.md`, install from GitHub (packs supported) into `~/.config/opencode/skills`, remove.

**Phase 4 — product completeness.** ✅ Workspaces (per-folder sessions, native OS folder dialog, typed paths, recents), session rename/delete, attachments (images/files as data URLs), Changes panel (engine snapshot diff, falling back to files touched by write/edit tools), first-run banner, production build verified.

**Logs.** ✅ `slog()` writes structured events (level, source, event, session, directory, redacted JSON) to the `logs` table in batches, so hot paths never wait on SQLite. A Logs modal, opened from the sidebar, shows them app-wide by default and copies a debugging bundle.

**Folder dialog.** The server opens the OS dialog on its own desktop (self-hosted, so browser and server share one). Windows: the modern Explorer picker (`IFileOpenDialog`, folder mode) called over COM from Windows PowerShell 5.1, owned by an invisible TopMost window so it opens in front. macOS: `osascript choose folder`. Linux: `zenity`, then `kdialog`. One dialog at a time; a new request replaces a stuck one; 3-minute timeout.

**`.sarib` (optional).** `src/server/sarib.ts`. The `sarib` MCP server is added per workspace, and only to folders with a `.sarib` file within three levels (dependency and build folders skipped; rescanned at most once a minute). The OpenCode proxy triggers the check on any request with a `directory`, and waits for it (up to 5 s) before a prompt so that turn already has the tools. OpenCode keeps MCP state per directory and runs local servers there, so the server sees only that workspace. Other workspaces never pay for its tool definitions. Needs Python 3.10+ and `sarib[mcp]`; the Skills page has an **Enable** button that runs `pip install --user "sarib[mcp]"` in the background (`/api/sarib`).

**Two modes (2026-09-24).** `SYRUP_MODE=local|cloud` (auto: cloud on Vercel) in `src/server/env.ts`. Everything above is local mode. Cloud mode is the hosted product at syrup.syedsarib.com, designed in [PLAN.md](PLAN.md): Google sign-in (Auth.js v5, JWT sessions, invite-only), Neon Postgres with forced row-level security (`src/server/db/pg`, every tenant query inside `withUser()`), per-user envelope-encrypted provider keys (`src/server/cloud`), legal documents with recorded consent, PostHog analytics with opt-out, admin page. The agent itself (a Vercel Sandbox per workspace) is Phase 2; until then cloud mode blocks the local-engine routes with 501 in `src/proxy.ts`.

**Local hardening (Phase 0, 2026-09-24).** Server binds 127.0.0.1; `src/proxy.ts` rejects non-loopback Host and cross-origin mutations; the OpenCode server runs with a per-process password that only the `/api/oc` proxy and server modules know; router and memory MCP require the same secret as bearer; the vault key lives in the user config dir, outside any workspace.

**Later.** Terminal (PTY endpoints exist), budgets and alerts, theme toggle, mobile layout, teams/organizations.

## Known issues

- ✅ Router verified with a real Google key (2026-09-23): a tool-calling turn hit a 503 on `gemini-3.8-flash`, failed over to `gemini-3.5-flash-lite`, and the follow-up turn (which needs the Gemini thought signature restored) succeeded on `gemini-3.8-flash`.
- Gemini 3.8 Flash on the free tier returns 503 "high demand" and 429 often. The router fails over, but each failover adds several seconds; the UI shows the engine's retry status while this happens.
- A session whose directory does not exist makes the engine return a bare "Unexpected server error". The workspace picker only offers existing folders, so this only bites API callers.
- `GET /session/{id}/diff` returned empty for sessions that did write files; the Changes panel falls back to listing touched files.
- Skills with the same name in two roots (e.g. `~/.claude/skills` and `~/.agents/skills`) trigger the engine's "duplicate skill name" warning and only one is listed; which one can change between reloads. That is why a skill occasionally disappears from the list. Fix on the user side: keep one copy.
- OpenCode Zen free models cannot be routed by syrup (they only accept requests from OpenCode itself). They remain selectable directly.

## Data (SQLite via Drizzle)

- `provider_keys` — provider id, label, encrypted key, tier (free/paid), rate-limit hints, enabled.
- `usage_events` — one row per assistant message: session, message, provider, model, tokens, cost, timestamp, key used.
- `router_events` — one row per routed request: alias, provider, model, key, tier, status, attempts, latency, tokens, real cost, error.
- `memories` — id, kind, content, embedding, tags, source session, timestamps.
- `logs` — structured application log: timestamp, level, source, event, session, directory, redacted JSON data.
- `settings` — key/value.

OpenCode keeps its own session and message storage. syrup does not duplicate it; the ledger keys off OpenCode message ids.

## Free tier notes (as of Sept 2026, verify before trusting)

- Google AI Studio: best free frontier model (Gemini Flash, 1M context, tools). Pro often quota-zero.
- Mistral Experiment: ~1B tokens/month incl. Devstral/Codestral. Data-training opt-in required.
- Groq: free, fast, but 6k–12k TPM. Only for small/fast tasks.
- OpenRouter: free models at 50 req/day, 1,000/day after one-time $10 top-up.
- Cerebras: no-card free tier ended mid-2026. $5 trial with card.
- NVIDIA NIM: ~1,000 req/day.
- OpenCode Zen: free models with no key (e.g. Nemotron 3 Ultra Free, 1M context).
- Free usually means prompts may train the model. The UI must say so per provider.
