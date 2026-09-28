# Deploy your own hosted syrup

How to run syrup in **cloud mode** on your own domain: Vercel (app + sandboxes), Neon Postgres, Google sign-in, PostHog analytics. The design behind it is in [PLAN.md](PLAN.md) and [PHASE2.md](PHASE2.md). Local mode needs none of this; see the [README](../README.md).

Placeholders used below:
- `<your-domain>` — the hostname the app runs on, e.g. `syrup.example.com`.
- `<apex-domain>` — the domain you own that it lives under, e.g. `example.com`.
- `<admin-email>` — the Google account that becomes the first admin.
- `<your-fork>` — your GitHub fork of this repository, e.g. `you/syrup`.

Console labels drift over time; if a label differs slightly, look for the nearest equivalent. Do the parts in order. Everything here fits the providers' free tiers.

**Rule for every secret:** paste it straight into Vercel → Environment Variables (or the provider's console). Never into chat, an issue, email, or a commit.

---

## Part 1 — Vercel project (first; the other parts need its URL)

1. Fork this repository on GitHub.
2. Sign in at https://vercel.com with the GitHub account that owns `<your-fork>`. Hobby (free) is the default.
3. Dashboard → **Add New…** → **Project**.
4. Under **Import Git Repository**, pick `<your-fork>`. If it is missing, click **Adjust GitHub App Permissions** and grant access to that repo.
   - Hobby cannot deploy a *private* repo owned by a GitHub *organization*. A personal-account repo (private or public) is fine.
5. Configure Project:
   - **Project Name:** `syrup` (any name works).
   - **Framework Preset:** Next.js (auto-detected).
   - **Root Directory:** `./`
   - Leave build settings default.
   - **Environment Variables:** skip for now; they are added in Part 8.
6. Click **Deploy**. The first build may fail until the env vars exist; that is expected. The project now exists with a `*.vercel.app` URL.
7. Project → **Settings** → **Security** → confirm **Secure backend access with OIDC federation** is on and issuer mode is **Team**. Vercel Sandbox uses this token automatically in deployments; nothing else to enable.
8. Project → **Settings** → **Environments** → **Production** → **Branch Tracking** = `main`.
9. Region: `vercel.json` pins functions to `fra1` (Frankfurt). Keep it next to your database region (Part 4), or change both together.

## Part 2 — Domain: `<your-domain>`

**In Vercel**
1. Project → **Settings** → **Domains** → **Add Domain**.
2. Enter `<your-domain>` → **Add**.
3. Vercel shows the record it wants. It currently recommends an **A record** for a subdomain: **Type A**, **Name** = the subdomain label (e.g. `syrup`), **IPv4 `76.76.21.21`**. Older guides say CNAME `cname.vercel-dns.com`; either works, use what Vercel shows. Leave this tab open.

**At your DNS provider** (Cloudflare shown; others are similar)
4. https://dash.cloudflare.com → account → **`<apex-domain>`** → **DNS** → **Records** → **Add record**.
5. **Type:** A · **Name:** the subdomain label · **IPv4 address:** the value Vercel showed · **Proxy status:** **DNS only** (grey cloud, *not* orange) · **TTL:** Auto → **Save**.
   - Why DNS-only: Vercel's docs say a Cloudflare proxy in front of Vercel causes redirect loops and TLS conflicts, and Vercel does not recommend it. Vercel already provides CDN, TLS and DDoS protection.
6. Back in Vercel, the domain status flips to **Valid Configuration** within minutes (DNS can take up to an hour). Vercel issues the TLS certificate automatically.
7. Optional but recommended: Cloudflare → **DNS** → **Settings** → enable **DNSSEC** (follow the DS-record step at your registrar if the registrar is not Cloudflare).

## Part 3 — Google sign-in (Google Auth Platform)

**A. Project and app registration**
1. https://console.cloud.google.com → project picker (top bar) → **New Project** → **Project name:** `syrup` → **Create** → select it.
2. Left menu → **APIs & Services** → **Google Auth Platform** (or search "Google Auth Platform"). Click **Get started**.
3. Wizard:
   - **App Information:** **App name** `syrup` · **User support email:** `<admin-email>` (or a shared support address).
   - **Audience:** **External**.
   - **Contact Information:** your contact address.
   - **Finish:** agree to the policy → **Create**.

**B. Branding** (Google Auth Platform → **Branding**)
4. **App name** `syrup`. **User support email** as above.
5. **App logo:** **leave empty.** Uploading a logo triggers Google's brand-verification review; without one there is nothing to review and the consent screen simply shows the app name and domain.
6. **App domain:**
   - **Application home page:** `https://<your-domain>`
   - **Application privacy policy link:** `https://<your-domain>/legal/privacy`
   - **Application terms of service link:** `https://<your-domain>/legal/terms`
   - These pages ship with the app (`src/content/legal/*.md`). Google requires that the privacy policy live on the same domain as the homepage. Fill in the `[bracketed]` placeholders in those files with your own operator details first.
7. **Authorized domains:** add `<apex-domain>`. Google requires the domain to be **verified as yours**: if prompted, verify via **Google Search Console** (https://search.google.com/search-console → **Add property** → **Domain** → `<apex-domain>` → add the TXT record it gives you at your DNS provider → **Verify**).
8. **Developer contact information:** your contact address → **Save**.

**C. Audience** (Google Auth Platform → **Audience**)
9. **Publishing status** starts as **Testing**, which caps sign-ins at **100 test users** you list by hand. Click **Publish app** → confirm. Status becomes **In production**.
   - Because syrup only requests the non-sensitive scopes `openid`, `email`, `profile`, **no verification review is required** to be in production. Anyone with a Google account can reach the sign-in; syrup's own invite list decides who gets in.

**D. Data Access** (Google Auth Platform → **Data Access**)
10. Optional: **Add or remove scopes** → tick `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` → **Update** → **Save**. Auth.js requests exactly these; listing them here just keeps the record accurate. Do **not** add any other scope.

**E. OAuth client** (Google Auth Platform → **Clients**)
11. **Create client** → **Application type:** **Web application** → **Name:** `syrup web`.
12. **Authorized JavaScript origins:**
    - `https://<your-domain>`
    - `http://localhost:3000`
13. **Authorized redirect URIs:**
    - `https://<your-domain>/api/auth/callback/google`
    - `http://localhost:3000/api/auth/callback/google`
14. **Create**. A dialog shows **Client ID** and **Client secret**. **The secret is shown only once.** Put them straight into Vercel (Part 8) as `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`. If you lose the secret, come back here and **Add secret** / rotate.
15. Google notes changes can take **5 minutes to a few hours** to propagate. Don't debug a `redirect_uri_mismatch` in the first minutes.

## Part 4 — Neon Postgres

**Option A — via Vercel Storage (simplest).** If your Neon account is managed by Vercel, create the database from Vercel, not the Neon console: Vercel → project → **Storage** → **Create Database** → **Neon** → region **Frankfurt (fra1)** (match `vercel.json`) → plan **Free** → **Auth toggle off** (syrup uses Auth.js) → connect to your project, environments Production + Preview + Development, **database branch for Preview** ticked, **no custom prefix**. Vercel injects `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and the `POSTGRES_*`/`PG*` variants automatically.

**Option B — standalone Neon account.**
1. https://console.neon.tech → sign up. Free plan is the default.
2. **New Project**:
   - **Project name:** `syrup`
   - **Postgres version:** leave the default (latest).
   - **Region:** **Europe (Frankfurt) — aws-eu-central-1** (or **Europe (London) — aws-eu-west-2**). **The region cannot be changed later.** An EU region keeps GDPR simple and matches the default `fra1` functions region.
   - **Create project**.
3. Top of the console → **Connect** → choose **Branch** `main` (production), **Database** `neondb`, **Role** the default owner.
4. Toggle **Connection pooling** **on**. The host now contains `-pooler`, e.g. `ep-xxxx-pooler.eu-central-1.aws.neon.tech`. Serverless functions open many short connections, so the pooled string is the one the app uses.
5. Copy the string (`postgresql://…-pooler…/neondb?sslmode=require`) into Vercel as `DATABASE_URL` (Part 8).
6. Copy the **unpooled** string (pooling off) into Vercel as `DATABASE_URL_UNPOOLED`; migrations run through it.
7. Optional: Neon → **Integrations** → **Vercel** → connect your project. This creates a **Neon branch per preview deployment** with its own connection string, so PRs test against the real schema.

**Create the app role (required for row-level security).** Neon's default owner role inherits `BYPASSRLS` from `neon_superuser`, which silently disables row-level security. The app therefore uses two connections ([PLAN.md](PLAN.md) §3, `src/server/db/pg/index.ts`):
- `DATABASE_URL_UNPOOLED` — the owner role. Runs migrations (applied automatically on first use) and admin aggregates only.
- `DATABASE_URL` — a dedicated `syrup_app` role with `NOBYPASSRLS`. Every request handler uses it.

Create that role in Neon's **SQL Editor**, connected as the owner. Create it with SQL, not in the console's Roles page: roles made there join `neon_superuser` and would bypass RLS again.

```sql
CREATE ROLE syrup_app WITH LOGIN PASSWORD '<strong-random-password>' NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO syrup_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO syrup_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO syrup_app;
-- Tables created later by migrations (run as the owner) get the same grants:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO syrup_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO syrup_app;
```

Then set `DATABASE_URL` to the **pooled** connection string with `syrup_app` and its password in place of the owner's (same host and database). If the Vercel integration injected `DATABASE_URL`, override it in Part 8. Check it with `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'syrup_app';` — it must return `false`.

## Part 5 — PostHog (EU)

1. https://eu.posthog.com/signup (EU region; the URL matters). Create an organization and a project.
2. When asked for a framework, pick **Next.js**; skip the wizard's code (syrup already has it).
3. Left menu → **Settings** → **Project** → **General** → copy **Project API key** (starts with `phc_`). It is safe to expose to browsers.
4. Into Vercel (Part 8): `NEXT_PUBLIC_POSTHOG_KEY` = that key, `NEXT_PUBLIC_POSTHOG_HOST` = `https://eu.i.posthog.com`.
5. Recommended: **Settings** → **Project** → **Session replay** → enable, set **Mask all inputs** and **Mask all text**. Chat text must never reach PostHog ([PLAN.md](PLAN.md) §6, layer B).

PostHog is optional: without the key, analytics are off.

## Part 6 — Admins and invites

Nothing to set up in a console. Two things to decide:
1. **Admins:** `<admin-email>` (comma-separate more). Set via `SYRUP_ADMIN_EMAILS`; admins see the admin page.
2. **First invites:** any number of emails, seeded from `SYRUP_INVITES` (comma-separated). After the first deploy, manage invites in the admin page. Sign-in with an email not on the list shows "invite only".

## Part 7 — Legal documents

The drafts in `src/content/legal/` (Terms, Privacy, Research Consent, Cookies) are served at `/legal/*`. Before inviting anyone outside a small test group:

1. Replace every `[bracketed]` placeholder (legal entity, address, country, representative) with your own details, and point the contact lines at a channel you monitor.
2. Adapt them to your retention schedule and subprocessors ([PLAN.md](PLAN.md) §6).
3. Have them reviewed by a lawyer. Questions worth bringing:
   - The correct **legal entity and jurisdiction** for the Terms (an individual vs. a company).
   - Whether an **EU representative (GDPR Art. 27)** is required if you are outside the EU/UK and serve EU users.
   - Sign-off on **consent unbundling**: service data under the Terms, research use of content under a separate opt-in.
   - **Retention schedule** and a **DPA template** for business users.
   - Minimum **age** wording (16 EU / 13 US).

## Part 8 — Environment variables in Vercel

Project → **Settings** → **Environment Variables** → **Add New**. For each: **Key**, **Value**, tick **Production** and **Preview**. Click **Save**. Redeploy once at the end (Deployments → ⋯ → **Redeploy**); env changes only apply to new deployments. The same names are listed in [`.env.example`](../.env.example).

| Key | Value | Source | Notes |
|---|---|---|---|
| `SYRUP_MODE` | `cloud` | — | Automatic on Vercel; set it only to force a mode. |
| `AUTH_SECRET` | 32+ random bytes, base64 | `npx auth secret --raw` or `openssl rand -base64 33` | Rotating it signs everyone out. |
| `AUTH_GOOGLE_ID` | Client ID | Part 3 E | |
| `AUTH_GOOGLE_SECRET` | Client secret | Part 3 E | Mark **Sensitive** so it can't be read back. |
| `DATABASE_URL` | pooled Neon string **as `syrup_app`** | Part 4 | The integration sets it to the owner role; replace it with the `syrup_app` string. Sensitive. |
| `DATABASE_URL_UNPOOLED` | direct Neon string (owner) | Part 4 | Set automatically by the integration. Migrations and admin reads only. |
| `SYRUP_MASTER_KEY` | 32 random bytes, base64 | `openssl rand -base64 32` | Wraps every user's data key. **Back it up offline.** Losing it loses every stored provider key. Sensitive. |
| `SYRUP_ADMIN_EMAILS` | `<admin-email>` | Part 6 | Comma-separated if more than one. |
| `SYRUP_INVITES` | first invitees' emails | Part 6 | Optional once the admin page manages invites. |
| `NEXT_PUBLIC_POSTHOG_KEY` | `phc_…` | Part 5 | Public by design. Optional. |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://eu.i.posthog.com` | Part 5 | |
| `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` | — | Preview deployments override automatically via `VERCEL_URL`. |
| `CRON_SECRET` | 32 random bytes | `openssl rand -base64 32` | Vercel sends it to the nightly job in `vercel.json` (`/api/cron/daily`: log retention, account deletions). Without it the job refuses to run. |

Optional:
- `SYRUP_AGENT_ENABLED=0` — kill switch: opening a workspace returns "paused for maintenance" instead of starting a sandbox ([PHASE2.md](PHASE2.md) S7).
- `SYRUP_OPS_TOKEN` — a long random token. A request with `Authorization: Bearer <token>` acts as the first admin in `SYRUP_ADMIN_EMAILS`, for scripted smoke tests. Leave unset unless you need it.

Not needed: `AUTH_URL` and `AUTH_TRUST_HOST` (Auth.js detects Vercel), any `VERCEL_*` variable (Sandbox authenticates with the deployment's OIDC token automatically).

**Local development against your cloud project:** run `npm i -g vercel`, then in the repo `vercel link` (choose your project) and `vercel env pull`. That writes `.env.local`, including a 12-hour `VERCEL_OIDC_TOKEN` for local Sandbox calls; re-run `vercel env pull` when it expires. `.env*` is git-ignored.

## Part 9 — Check everything

1. `https://<your-domain>` loads over HTTPS with Vercel's certificate.
2. Vercel → Settings → Domains shows **Valid Configuration**.
3. Google Auth Platform → **Audience** shows **In production**.
4. Neon → the project region is the one you chose; **Connect** with pooling shows `-pooler` in the host.
5. If you use PostHog, the project URL begins with `https://eu.posthog.com/project/`.
6. Vercel → Environment Variables lists the required keys from Part 8 for Production and Preview.
7. Sign in with `<admin-email>`: you land in the app and the admin page is available.
8. On your fork: GitHub → **Settings** → **Code security** → enable **Private vulnerability reporting**, **Dependabot alerts**, **Secret scanning** and **Push protection**.
