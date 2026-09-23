# syrup cloud — the plan

**Status:** approved direction, 2026-09-23. Supersedes the "Later" section of [ARCHITECTURE.md](ARCHITECTURE.md).
**Owner:** Sarib. **Written by:** Claude, from the code in this repo and the sources listed at the end.

## 0. Decisions already made

| Question | Decision |
|---|---|
| What is syrup? | **A hosted web product first** (`syrup.syedsarib.com`), with the local self-hosted mode kept as a second mode of the same codebase, finished later. |
| Who can sign in? | **Anyone with a Google account.** |
| Login always required? | **Yes**, in cloud mode. Local mode stays login-free. |
| Tenancy | **Fully separate per user**: own workspaces, keys, chats, memory, usage, skills. |
| Google's role | **Sign-in only.** Provider API keys are a separate flow. |
| Data | **Store everything** needed to run the service, protected to best practice, with terms users accept. Research use of content is a **separate consent**. |
| Budget | **$0/month** for hosting until the product earns money. Every service below has a free tier that fits a private beta. |
| Analytics | PostHog Cloud (free tier), product analytics + session replay + feature flags. |
| Access control | **Invite-only, managed by Sarib by hand** in the admin page. No automatic per-user caps or quotas; usage is shown, not enforced. |

## 1. The one-paragraph architecture

The browser talks to a **Next.js app on Vercel** for everything that is *about* the user: sign-in (Auth.js + Google), workspaces, keys, chats list, usage, memory, skills, settings, analytics, legal. The agent itself runs in a **Vercel Sandbox per workspace**: a Firecracker microVM with the user's repo, OpenCode, and syrup's **router + memory sidecar**. The browser connects **directly** to that sandbox's public URL (basic auth, per-sandbox password) for the live chat stream, so Vercel's 300 s function limit never touches the agent. The sidecar reports usage, transcripts, and router events back to the app's **ingest API**, which writes them to **Neon Postgres** under the user's id with row-level security. Provider keys live encrypted in Postgres, are decrypted only at sandbox start, and are handed to the sidecar **in memory, never on the sandbox disk**, so snapshots never contain secrets.

```
 Browser ── HTTPS ──▶ syrup.syedsarib.com (Next.js on Vercel)
    │                     │  Auth.js (Google)  ·  Drizzle → Neon Postgres (RLS)
    │                     │  /api/workspaces  /api/keys  /api/memory  /api/ingest  /api/legal
    │                     │  PostHog (server + client events)
    │                     ▼
    │            @vercel/sandbox  ── create / resume / stop ──▶  Sandbox  "u_<user>_<workspace>"
    │                                                            ├─ /vercel/sandbox/<repo>   (persistent snapshot)
    │                                                            ├─ opencode serve :4096  (OPENCODE_SERVER_PASSWORD)
    └── HTTPS + basic auth (direct, SSE) ───────────────────────▶├─ syrup sidecar :4210  router /v1 · memory MCP /mcp
                                                                 │      keys in env only → provider APIs
                                                                 └─ egress allow-list (network policy)
```

Why this shape and not the alternatives:

- **Vercel functions cannot host the agent** (no long-lived process, 300 s max on Hobby, no WebSockets). A sandbox can. Vercel's own guide runs OpenCode this way.
- **Cloudflare Workers/Containers cannot** (no processes on Workers; Containers need the $5/month Workers Paid plan).
- **Direct browser → sandbox** avoids proxying a long SSE stream through a function.
- **The router inside the sandbox** keeps the current design intact (OpenCode sees only `syrup/auto` at $0; the router holds keys and reports real spend) and keeps keys off disk.

## 2. Services and what they cost

| Layer | Service | Free tier that we rely on | Upgrade trigger |
|---|---|---|---|
| Web app + API | **Vercel Hobby** | 1M function invocations, 100 GB transfer, 300 s max function, 200 projects. **Non-commercial use only.** Donations allowed; payments, ads or paid work are not. | The day you charge money or run ads → **Pro $20/mo**. |
| Agent compute | **Vercel Sandbox (Hobby)** | 5 CPU-hours, 420 GB-hours memory, 5,000 creations, 20 GB egress, 15 GB snapshots, **10 concurrent**, **45-min sessions**, 1–4 vCPU. | More than ~10 people using it at once, or >~200 sandbox-hours/month → Pro (usage billed against $20 credit). |
| Database | **Neon Postgres (Free)** | 0.5 GB storage/project, 100 CU-hours, autosuspend after 5 min (cold start ~0.5 s), 10 branches, PITR. | 0.5 GB of transcripts (roughly 100k messages) → Launch plan. |
| Auth | **Auth.js v5 + Google** | Free. Google OAuth consent screen in "Production" with non-sensitive scopes (email, profile) needs no verification. | None. |
| Analytics | **PostHog Cloud (EU)** | 1M events, 5k session replays, 1M flag requests, 100k errors per month. No card. | Beyond those numbers. |
| DNS + edge | **Cloudflare Free** | DNS for `syedsarib.com`, DNSSEC, 3 WAF custom rules, rate-limiting rule, Turnstile. Record must be **DNS-only (grey cloud)** for Vercel. | None. |
| Object storage | **Cloudflare R2** (later, for attachments/exports) | 10 GB, 1M writes, 10M reads/month, no egress fees. | Beyond that. |
| Email (later) | Resend free | 3k emails/month (data-request confirmations). | Beyond that. |
| Legal docs | Templates + one lawyer review | Lawyer review is the only real cost in this plan; budget for it before public launch. | — |

Rejected on purpose: **Cloudflare Access** for login (free plan is capped at 50 users; we want anyone). **Turso** database-per-user (free plan caps at 100 databases). **Supabase** (free projects pause after a week idle). **E2B** (one-time $100 credit, then paid). **Fly/Render/Railway** (no usable free tier for an always-on VM).

## 3. What "fully separate per user" means in code

1. **Every table has `user_id`.** No exceptions except `legal_documents` and `settings_global`.
2. **Postgres row-level security on every table.** The app sets `SET LOCAL app.user_id = '<id>'` at the start of each transaction; policies filter on it. Even a bug in a query cannot leak another user's rows.
3. **One sandbox per workspace, named `u_<userId>_<workspaceId>`.** Nothing shared. Vercel's microVM boundary is the isolation.
4. **Envelope encryption for provider keys.** Each user has a data-encryption key (DEK) wrapped by the master key (Vercel env `SYRUP_MASTER_KEY`). Provider keys are AES-256-GCM under the user's DEK. Rotating the master key rewraps DEKs, not every secret.
5. **Keys never touch sandbox disk.** Decrypted at resume, passed as env to the sidecar process, gone when the session stops. The sidecar is the only thing that ever holds them.
6. **Per-sandbox OpenCode password**, random, stored encrypted, rotated on every resume.
7. **Sandbox egress allow-list.** Default: the model providers the user has keys for, GitHub, npm/pypi registries, and the syrup ingest URL. User can add domains per workspace.

## 4. Security baseline (must ship before anyone else logs in)

Findings from the current code and the fix for each. Items marked *(local too)* apply to local mode as well.

| # | Finding | Fix |
|---|---|---|
| S1 | No authentication on any `/api/*` route. | Auth.js `proxy.ts` guards every route except `/api/auth/*`, `/api/ingest` (sandbox token), `/api/health`, and legal pages. |
| S2 | Next.js listens on all interfaces; anyone on the LAN can drive the agent. *(local too)* | Local mode binds `127.0.0.1` and requires a first-run local token cookie. Cloud mode is behind Auth.js. Check `Host`/`Origin` on every mutating request. |
| S3 | OpenCode server has no password; router key is hard-coded `"syrup"`. *(local too)* | Random secret per boot (local) / per resume (cloud). `OPENCODE_SERVER_PASSWORD` set; router requires it as bearer. |
| S4 | Agent can read `data/vault.key` + `syrup.db` and decrypt all keys. *(local too)* | Cloud: keys never on disk (§3.5). Local: vault key moves to `~/.config/syrup/`, OpenCode permission rule denies syrup's own `data/`. |
| S5 | Skills installed from any GitHub repo are executed instructions. | Preview + confirm before install; skills are per user; a `verified` flag for a curated list later. |
| S6 | `/api/workspace?path=` lists any folder on the server. | Cloud: route removed; workspaces are git repos or empty. Local: unchanged, behind local token. |
| S7 | `osascript` start path is interpolated with only `"` escaped. *(local too)* | Escape `\` and `"`, or pass via env. |
| S8 | `logs` grow forever. | Retention job (§8). |
| S9 | Free OpenCode Zen models may train on prompts (Big Pickle, Nemotron). | Label them in the model picker; off by default in cloud. |
| S10 | No CSRF protection on mutating routes. | Auth.js CSRF token on its own routes; same-origin check + `SameSite=Lax` cookies on ours. |
| S11 | No rate limiting or abuse controls. | Cloudflare rate-limiting rule on `/api/auth/*` and `/api/workspaces` (sandbox creation) against bots. No per-user quotas: access is by invite, controlled manually. |
| S12 | Secrets in Vercel env, sandbox images, snapshots. | Only Vercel env holds `SYRUP_MASTER_KEY`, `AUTH_SECRET`, `AUTH_GOOGLE_*`, `DATABASE_URL`, `POSTHOG_KEY`, `VERCEL_OIDC` for Sandbox. Images contain no secrets. Snapshots contain no secrets (§3.5). |

Repository hygiene for open source: `SECURITY.md` + GitHub private vulnerability reporting; branch protection on `main` (PR + CI required); Dependabot for npm and Actions; Actions pinned to SHAs; secret scanning + push protection; `CODEOWNERS` on `src/server/**` and `src/app/api/**`; CI never gets secrets on fork PRs (`pull_request` only, never `pull_request_target`).

## 5. Data model v2 (Postgres, Drizzle)

Conventions: ULID text primary keys (`id`), `timestamptz` columns named `created_at` / `updated_at`, `user_id` on every tenant table, composite index `(user_id, created_at desc)` on every event-like table, RLS policy on every tenant table, soft delete via `deleted_at` where users can delete, hard delete job runs after retention.

**Identity (Auth.js adapter tables)**
- `users` — id, email, name, image, `created_at`, `last_seen_at`, `deleted_at`, `plan` (`free` for now).
- `accounts`, `sessions`, `verification_tokens` — Auth.js standard.
- `user_keys` — user_id, `dek_wrapped`, `wrap_version`, `created_at`. One row per user.

**Workspaces and compute**
- `workspaces` — id, user_id, name, `source` (`git` | `empty`), `repo_url`, `default_branch`, `egress_allow` (text[]), `created_at`, `last_opened_at`, `deleted_at`.
- `sandboxes` — id, workspace_id, user_id, `vercel_name`, `region`, `status` (`stopped` | `starting` | `running` | `error`), `password_enc`, `vcpus`, `last_session_started_at`, `last_session_ended_at`, `total_session_seconds`.

**Chat (the full record)**
- `chat_sessions` — id, user_id, workspace_id, `engine_session_id`, `title`, `agent`, `model_alias`, `created_at`, `updated_at`, `archived_at`, `deleted_at`.
- `messages` — id, user_id, chat_session_id, `engine_message_id`, `role`, `parts` (jsonb: text, tool calls, tool results, attachments refs), `model_id`, `provider_id`, tokens ×5, `cost`, `free`, `created_at`, `completed_at`. This is where "store everything" lives.
- `attachments` — id, user_id, message_id, `r2_key`, `mime`, `bytes`, `sha256`, `created_at` (R2 comes later; until then attachments stay inline in `parts` and are size-capped).

**Providers**
- `provider_keys` — id, user_id, provider_id, label, `secret_enc`, hint, tier, enabled, active, `created_at`, `last_used_at`.
- `router_events` — id, user_id, workspace_id, chat_session_id, `ts`, alias, provider_id, model_id, key_id, tier, status, http_status, attempts, latency_ms, tokens, cost, error.
- `usage_daily` — materialized rollup: user_id, day, provider_id, model_id, messages, tokens, cost, free_tokens. Rebuilt by the nightly job; the dashboard reads this, not raw rows.

**Memory and skills**
- `memories` — id, user_id, workspace_id (nullable = global), kind, title, content, tags (text[]), source, `search` (tsvector, GIN index), `created_at`, `updated_at`, `deleted_at`. Replaces SQLite FTS5.
- `skills` — id, user_id, name, description, `source` (`paste` | `git`), `source_ref`, content, enabled, `created_at`.

**Trust, safety, legal**
- `legal_documents` — id, kind (`terms` | `privacy` | `research_consent` | `dpa`), version, `published_at`, `content_hash`, url.
- `consents` — id, user_id, legal_document_id, `granted_at`, `revoked_at`, `ip_hash`, `user_agent`. Append-only audit trail; "does this user consent to X" = latest row for that kind with no `revoked_at`.
- `data_requests` — id, user_id, type (`export` | `delete`), status, `requested_at`, `completed_at`, `download_url_enc`, `expires_at`.
- `audit_log` — id, user_id (nullable), actor (`user` | `system` | `admin`), action, target, `ip_hash`, `created_at`. Key add/remove, workspace create/delete, consent change, export, delete, sign-in.

**Operations**
- `logs` — as today plus user_id, workspace_id; 14-day retention.
- `invites` — id, email, `invited_by`, `note`, `created_at`, `accepted_at`, `revoked_at`. Sign-in succeeds only for an email with an open invite (or an existing user). Usage per user is read from `sandboxes.total_session_seconds` and `usage_daily`; shown in the admin page, never enforced.

Migration path from SQLite: local mode keeps SQLite with the same Drizzle schema where possible (Drizzle supports both dialects from one codebase via two schema files sharing column definitions). Cloud mode uses Postgres. `router_events`, `usage_events`, `memories`, `logs` map 1:1; new tables are cloud-only.

## 6. Analytics and data (what we collect, under which basis)

Three layers, each with a different legal basis. This is what makes "store everything" defensible.

**Layer A — Service data (needed to run the product).** Account, workspaces, chats, messages, keys (encrypted), usage, memory, skills, logs. Basis: contract (the Terms). Stored for the life of the account; deleted 30 days after account deletion (backups 30 more).

**Layer B — Product analytics (understand and improve the app).** PostHog events: sign-in, workspace created, sandbox start/resume/stop with duration, message sent (count, model alias, tokens bucket, latency, error type), feature used, page views, session replays **with input masking on** and chat text masked. No prompt or code content ever goes to PostHog. Basis: legitimate interest, with a one-click opt-out in Settings and `DNT` respected. EU-hosted PostHog project.

**Layer C — Research data (train, evaluate, publish).** Use of message content, tool calls and outcomes for improving the router, prompts, or models, and for anonymized research. Basis: **explicit, unbundled consent**, a separate toggle at first run and in Settings, off by default, revocable (GDPR Art. 7(4): consent cannot be a condition of using the service). Consent is recorded in `consents`; the research pipeline filters on it at query time, so revoking excludes the data going forward and triggers deletion from research sets.

Rights and plumbing (needed under GDPR/UK GDPR/CCPA regardless of where the company is):
- **Export**: `POST /api/data-requests` → job builds a zip (JSON per table + attachments) to R2 → signed link emailed, 7-day expiry.
- **Delete**: same route; account soft-deleted at once, sandbox and snapshots deleted at once, rows hard-deleted after 30 days, PostHog person deleted via API.
- **Retention schedule** (published in the privacy policy): logs 14 days; router/usage raw events 13 months then rolled up; messages for account life; audit log 2 years; consents 6 years after revocation.
- **Subprocessor list** (public page): Vercel (hosting, sandboxes, US/EU regions), Neon (database, EU region), PostHog (analytics, EU), Google (sign-in), Cloudflare (DNS), the model providers the user connects (their own keys, their own terms).
- **Documents**: Terms of Service, Privacy Policy, Research Consent text, Cookie notice (only essential cookies + PostHog opt-out, so no banner needed), DPA for any business user who asks. Draft from templates, **one lawyer review before public launch.**
- **Age**: 16+ (EU) / 13+ (US) stated in Terms; Google returns no age, so it is an attestation.

## 7. Phases

Each phase ends with something deployed and usable. Estimates are working days for one person with Claude.

### Phase 0 — Cut the immediate risks (1–2 days)
- S2, S3, S4, S7 for local mode; `SECURITY.md`; branch protection; Dependabot; secret scanning. Ship as one commit. Local users are safe from now on and the repo is ready to be public.

### Phase 1 — Foundation on Vercel (4–6 days)
- `SYRUP_MODE=cloud|local` switch in `env.ts`; engine behind an interface (`LocalEngine` today, `SandboxEngine` in Phase 2).
- Auth.js v5 + Google provider; `proxy.ts` guarding all routes; sign-in page; account menu.
- Neon project (EU); Drizzle Postgres schema from §5; RLS policies; `set local app.user_id`; envelope encryption for keys.
- Deploy to Vercel; `syrup.syedsarib.com` via Cloudflare **DNS-only CNAME → `cname.vercel-dns.com`**; Google OAuth redirect `https://syrup.syedsarib.com/api/auth/callback/google`.
- PostHog project (EU), server-side client, first 10 events, opt-out setting.
- Legal pages as drafts, `consents` recording on first sign-in (Terms + Privacy acceptance; research toggle default off).
- **Result:** you can sign in with Google on the real domain; nothing agentic yet.

### Phase 2 — The agent in a sandbox (6–9 days)
- `SandboxEngine`: `Sandbox.getOrCreate({ name, ports: [4096, 4210], resources: { vcpus: 1 }, timeout: 45 min, onCreate: install OpenCode + sidecar + clone repo, onResume: start OpenCode with a fresh password, start sidecar with keys in env })`.
- **Sidecar** = today's `src/server/router` + `src/server/mcp.ts` + `ledger.ts` packaged as one Node script, with a new **ingest client** that POSTs usage/router/message events to `/api/ingest` with a per-sandbox bearer token. Memory tools call `/api/memory` with the same token instead of SQLite.
- Browser: OpenCode SDK pointed at `sandbox.domain(4096)` with basic auth (the same `oc(dir)` pattern as today, different base URL and headers). SSE goes direct.
- Session lifecycle: resume on open; heartbeat from the browser; `extendTimeout` while a turn is running; stop after 10 idle minutes (saves the 420 GB-hour budget); auto-resume on the next message with a "waking up your workspace…" state; graceful handling of the 45-minute cap (persistent snapshot, resume, replay from the engine's session).
- Workspaces UI: "New workspace" = paste a public git URL, connect GitHub (OAuth, read-only) for private repos, or empty. Native folder picker hidden in cloud mode.
- Egress allow-list defaults per provider; per-workspace override.
- Invite check at sign-in (`invites` table); usage meter in Settings and admin page (informational only).
- **Result:** the full product works on the domain for one user, then for invited users.

### Phase 3 — Data, analytics, rights (4–5 days)
- Full transcript sync to `messages` from engine events (via ingest), chats list from Postgres (no sandbox boot needed to browse history).
- Export and delete requests end to end; R2 for export bundles and attachments; Resend for the email.
- Retention jobs on Vercel Cron (Hobby allows 2 daily jobs): nightly `usage_daily` rollup + retention deletes; weekly hard-delete pass.
- PostHog: funnels (sign-in → workspace → first message → day-2 return), replays with masking, feature flags for gradual rollout, error tracking wired to the Logs layer.
- Admin page (you only, allow-listed email): users, sandbox pool usage, quota adjustments, consent stats, data-request queue.
- **Result:** every legal obligation has a button behind it; you can see how people use the product.

### Phase 4 — Hardening and private beta (3–4 days)
- Cloudflare WAF rules and rate limits; Turnstile on the sign-in page if bot sign-ups appear.
- Invites managed by Sarib in the admin page (add email, revoke). No automatic caps; the Vercel usage dashboard and the admin usage view are how load is watched.
- Threat-model doc, pen-test checklist run with Claude's security review, dependency audit, headers (CSP, HSTS, frame-ancestors).
- Status page (free: Upptime on GitHub Pages) and uptime alerts.
- Lawyer review of the legal documents. Publish. Open the beta.

### Phase 5 — After beta (as needed)
- Move to Vercel Pro when either revenue starts or the sandbox pool is the bottleneck. Cost model: a 1 vCPU / 2 GB sandbox costs ≈ $0.04–0.06 per active hour on Pro.
- **Local connector mode**: the existing local server becomes an optional "bring your own compute" agent that registers with the cloud app, so people with big repos or private networks run the agent on their own machine while keeping cloud accounts, history and analytics. This is the "both" you asked for, and it also makes heavy users free to serve.
- Teams/orgs (`organizations`, `memberships`), shared workspaces, billing (Stripe) with the Pro plan.

## 8. Operations runbook (short)

- **Deploy**: push to `main` → Vercel production. Preview deploys per PR with Neon branches (free) so schema changes are tested against real data shapes.
- **Migrations**: `drizzle-kit generate` in the PR; applied by a Vercel build step against the target branch DB.
- **Secrets rotation**: `SYRUP_MASTER_KEY` rotation = rewrap all `user_keys` (job), keep old key until done. `AUTH_SECRET` rotation logs everyone out; announce.
- **Backups**: Neon PITR (1 day on Free, keep in mind); weekly logical dump to R2 via cron (encrypted with a backup key).
- **Incident**: kill switch feature flag (`agent_enabled`) in PostHog; sandbox `stop` all via `Sandbox.list({ tags })`; rotate master key if exposure suspected; notify affected users within 72 h (GDPR).
- **Quotas**: watch Vercel usage dashboard weekly until Pro; alert at 80 % of sandbox memory-hours.

## 9. Risks and honest limits

- **Vercel Hobby is non-commercial.** The product must earn nothing, show no ads, and take no payments while on Hobby. Donations are allowed. Moving to Pro is a $20/month decision the day that changes.
- **10 concurrent sandboxes and ~50–100 usable sandbox-hours a month (CPU-bound).** Enough for a small invited group, not a public launch. Sarib controls invites by hand and watches usage; nothing is enforced automatically.
- **45-minute sessions.** Long agent runs are interrupted and resumed. The UX must make this ordinary, not an error.
- **Neon Free autosuspends after 5 minutes.** First request after idle is ~0.5–1 s slower. Acceptable; a keep-warm cron is against the spirit of the free tier.
- **Google OAuth app publishing.** External apps in "Testing" cap at 100 users; set the consent screen to "Production". With only email/profile scopes there is no verification review, but the consent screen shows your app name and domain, which must match the site.
- **OpenCode is single-user by design.** Our isolation comes from one process per sandbox, not from OpenCode. Never share a sandbox between users.
- **Coding agents need broad egress** (package registries, docs). The allow-list will annoy some users; make adding a domain one click.
- **Snapshots persist the filesystem.** Anything the agent writes to disk persists, including secrets a user pastes into a file. Warn in the UI; keys themselves never touch disk (§3.5).
- **You are the only admin.** The admin page and the runbook exist so that stays manageable.

## 10. What Sarib has to do (accounts and approvals)

1. **Google Cloud**: create a project "syrup", OAuth consent screen (External, Production, scopes `openid email profile`), OAuth client (Web) with redirect `https://syrup.syedsarib.com/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`. Give Claude the client id and secret as Vercel env values (not in chat).
2. **Vercel**: create the project from the GitHub repo, add the domain `syrup.syedsarib.com`, enable Sandbox for the project.
3. **Cloudflare DNS**: `CNAME syrup → cname.vercel-dns.com`, proxy **off** (grey cloud).
4. **Neon**: create a project in an EU region, copy the pooled connection string into Vercel env.
5. **PostHog**: create an EU project, copy the project key into Vercel env.
6. **Decide who gets the first invites** (the admin page is where they are added).
7. **Book a lawyer review** of Terms, Privacy, Research Consent before public launch (Phase 4).

## 10b. Capacity benchmarks on the $0 stack

Hard caps (verified): 10 concurrent sandboxes · 5 sandbox CPU-hours/mo · 420 GB-hours sandbox memory/mo · 45-min sessions · 15 GB snapshots · 5,000 creations · 20 GB egress · Vercel functions 1M invocations, 360 GB-h, 300 s · Neon 0.5 GB + 100 CU-h (≈400 awake-hours at 0.25 CU) · PostHog 1M events, 5k replays · Hobby cron once/day (±59 min).

Derived (assumes 1 vCPU / 2 GB, 30 min active + 10 min idle per session, 5–10 % CPU utilization):

| Metric | Estimate | Limiting resource |
|---|---|---|
| Agent sessions / month | ~75–150 | Sandbox active CPU (5 h) |
| Agent sessions / day | ~3–5 | same |
| Daily active agent users | 3–5 daily, or 10–15 people 2–3×/week | same |
| Peak concurrent users | 10 | Concurrency cap |
| Saved (persistent) workspaces | ~10–50 | 15 GB snapshots at 0.3–1.5 GB each |
| Registered accounts | effectively unlimited | — |
| Stored messages before DB upgrade | ~100k (≈5 KB avg, tool output capped 16 KB) | Neon 0.5 GB |
| Analytics sessions / month | ~3,000 at 300 events each | PostHog 1M |
| App-side daily users | hundreds | Vercel functions (chat stream bypasses them) |

Planning headline: **20–30 invited people using it a few times a week is the realistic $0 ceiling.** Invites are controlled by Sarib manually; these numbers say how many to send, nothing enforces them.

Stretch, by impact: disable LSP in cloud mode (biggest idle CPU burner); idle-stop at 5 min via sandbox `timeout` + browser heartbeat (no cron needed); 1 vCPU only; per-user daily sandbox-minutes quota with a visible meter; `keepLastSnapshots: 1`, 7-day expiry, drop `node_modules` before stop for large repos; block watchers/dev servers in cloud mode; local connector for heavy users (Phase 5).

Pro ($20/mo incl. $20 credit): 10,000 concurrent, 24 h sessions, 800 s functions, per-minute cron. A 1 vCPU / 2 GB sandbox at 10 % CPU ≈ $0.055/h → the credit ≈ 360 sandbox-hours ≈ 18 sessions/day ≈ 15–20 daily active users; $100/mo ≈ 90 daily active users; beyond that ≈ $1.60 per user per month at one 40-min session a day.

## 11. Sources checked on 2026-09-23

- Vercel Hobby plan limits and non-commercial rule: https://vercel.com/docs/plans/hobby · https://vercel.com/docs/limits/fair-use-guidelines
- Vercel Sandbox pricing, Hobby quotas, 45-minute sessions, 10 concurrent: https://vercel.com/docs/sandbox/pricing
- Persistent sandboxes, `getOrCreate`, `onResume`, snapshots: https://vercel.com/docs/sandbox/concepts/persistent-sandboxes
- Running OpenCode in a sandbox with exposed port + password: https://vercel.com/kb/guide/running-opencode-securely-with-the-vercel-sandbox
- OpenCode server auth (`OPENCODE_SERVER_PASSWORD`, `--cors`): https://opencode.ai/docs/server
- Auth.js Google provider and Next.js 16 `proxy.ts`: https://authjs.dev/getting-started/providers/google · https://authjs.dev/getting-started/installation?framework=Next.js
- Neon Free plan: https://neon.com/pricing · Turso Free plan (100 DB cap): https://turso.tech/pricing
- PostHog free tier: https://posthog.com/pricing
- Cloudflare Workers/Containers pricing: https://developers.cloudflare.com/workers/platform/pricing/ · Zero Trust 50-user free cap: https://community.cloudflare.com/t/50-user-limit-on-free-plan/546057
- Cloudflare DNS with Vercel (DNS-only): https://vercel.com/kb/guide/cloudflare-with-vercel
- E2B pricing: https://e2b.dev/pricing
- GDPR for SaaS checklists (consent, retention, DPA, subprocessors): https://www.complyone.io/guides/gdpr/gdpr-for-saas · https://secureprivacy.ai/blog/data-processing-agreements-dpas-for-saas · https://securespells.com/blog/gdpr-compliance-guide-saas-2026/
- Community multi-user OpenCode deployments (one instance per user): https://github.com/cahya-wirawan/opencode-multiuser · https://github.com/opencolin/opencode-cloud
