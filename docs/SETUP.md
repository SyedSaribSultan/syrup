# syrup cloud — account setup guide

Companion to [PLAN.md](PLAN.md). Verified against each provider's docs on 2026-09-23; console labels drift, so if a label differs slightly, look for the nearest equivalent. Do each part in order. Nothing here costs money.

**Rule for every secret:** paste it straight into Vercel → Environment Variables (or the provider's console). Never into chat, Slack, email, or a commit.

---

## Part 1 — Vercel project (do this first; other parts need its URL)

1. Sign in at https://vercel.com with the GitHub account that owns `SyedSaribSultan/syrup`. Hobby (free) is the default.
2. Dashboard → **Add New…** → **Project**.
3. Under **Import Git Repository**, pick `SyedSaribSultan/syrup`. If it is missing, click **Adjust GitHub App Permissions** and grant access to that repo.
   - Hobby cannot deploy a *private* repo owned by a GitHub *organization*. A personal-account repo (private or public) is fine.
4. Configure Project:
   - **Project Name:** `syrup`
   - **Framework Preset:** Next.js (auto-detected)
   - **Root Directory:** `./`
   - Leave build settings default.
   - **Environment Variables:** skip for now; we add them in Part 8.
5. Click **Deploy**. The first build will fail or be useless until Phase 1 code lands; that is expected. The project now exists with a `*.vercel.app` URL.
6. Project → **Settings** → **Security** → confirm **Secure backend access with OIDC federation** is on and issuer mode is **Team**. Sandbox uses this token automatically in deployments; nothing else to "enable".
7. Project → **Settings** → **Environments** → **Production** → **Branch Tracking** = `main`.

## Part 2 — Domain: `syrup.syedsarib.com`

**In Vercel**
1. Project → **Settings** → **Domains** → **Add Domain**.
2. Enter `syrup.syedsarib.com` → **Add**.
3. Vercel shows the record it wants: **Type CNAME**, **Name `syrup`**, **Value** something like `cname.vercel-dns.com` **or** a project-specific host like `d1d4fc829fe7bc7c.vercel-dns-017.com`. **Copy the exact value shown.** Leave this tab open.

**In Cloudflare**
4. https://dash.cloudflare.com → account → **syedsarib.com** → **DNS** → **Records** → **Add record**.
5. **Type:** CNAME · **Name:** `syrup` · **Target:** the exact value from step 3 · **Proxy status:** **DNS only** (grey cloud, *not* orange) · **TTL:** Auto → **Save**.
   - Why DNS-only: Vercel's docs say a Cloudflare proxy in front of Vercel causes redirect loops and TLS conflicts, and Vercel does not recommend it. Vercel already provides CDN, TLS and DDoS protection.
6. Back in Vercel, the domain status flips to **Valid Configuration** within minutes (DNS can take up to an hour). Vercel issues the TLS certificate automatically.
7. Optional but recommended: Cloudflare → **DNS** → **Settings** → enable **DNSSEC** (follow the DS-record step at your registrar if the registrar is not Cloudflare).

## Part 3 — Google sign-in (Google Auth Platform)

**A. Project and app registration**
1. https://console.cloud.google.com → project picker (top bar) → **New Project** → **Project name:** `syrup` → **Create** → select it.
2. Left menu → **APIs & Services** → **Google Auth Platform** (or search "Google Auth Platform"). Click **Get started**.
3. Wizard:
   - **App Information:** **App name** `syrup` · **User support email:** your Google address (the one you'll use as admin).
   - **Audience:** **External**.
   - **Contact Information:** your email.
   - **Finish:** agree to the policy → **Create**.

**B. Branding** (Google Auth Platform → **Branding**)
4. **App name** `syrup`. **User support email** as above.
5. **App logo:** **leave empty for now.** Uploading a logo triggers Google's brand-verification review; without one there is nothing to review and the consent screen simply shows the app name and domain.
6. **App domain:**
   - **Application home page:** `https://syrup.syedsarib.com`
   - **Application privacy policy link:** `https://syrup.syedsarib.com/legal/privacy`
   - **Application terms of service link:** `https://syrup.syedsarib.com/legal/terms`
   - These pages exist from Phase 1 (drafts are fine). Google requires that the privacy policy live on the same domain as the homepage.
7. **Authorized domains:** add `syedsarib.com`. Google requires the domain to be **verified as yours**: if prompted, verify via **Google Search Console** (https://search.google.com/search-console → **Add property** → **Domain** → `syedsarib.com` → add the TXT record it gives you in Cloudflare DNS → **Verify**).
8. **Developer contact information:** your email → **Save**.

**C. Audience** (Google Auth Platform → **Audience**)
9. **Publishing status** starts as **Testing**, which caps sign-ins at **100 test users** you list by hand. Click **Publish app** → confirm. Status becomes **In production**.
   - Because syrup only requests the non-sensitive scopes `openid`, `email`, `profile`, **no verification review is required** to be in production. Anyone with a Google account can sign in.

**D. Data Access** (Google Auth Platform → **Data Access**)
10. Optional: **Add or remove scopes** → tick `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` → **Update** → **Save**. Auth.js requests exactly these; listing them here just keeps the record accurate. Do **not** add any other scope.

**E. OAuth client** (Google Auth Platform → **Clients**)
11. **Create client** → **Application type:** **Web application** → **Name:** `syrup web`.
12. **Authorized JavaScript origins:**
    - `https://syrup.syedsarib.com`
    - `http://localhost:3000`
13. **Authorized redirect URIs:**
    - `https://syrup.syedsarib.com/api/auth/callback/google`
    - `http://localhost:3000/api/auth/callback/google`
14. **Create**. A dialog shows **Client ID** and **Client secret**. **The secret is shown only once.** Put them straight into Vercel (Part 8) as `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`. If you lose the secret, come back here and **Add secret** / rotate.
15. Google notes changes can take **5 minutes to a few hours** to propagate. Don't debug a "redirect_uri_mismatch" in the first minutes.

## Part 4 — Neon Postgres

1. https://console.neon.tech → sign up (GitHub or Google sign-in is fine). Free plan is the default.
2. **New Project**:
   - **Project name:** `syrup`
   - **Postgres version:** leave the default (latest).
   - **Region:** **Europe (Frankfurt) — aws-eu-central-1** (or **Europe (London) — aws-eu-west-2**). **The region cannot be changed later.** EU keeps the GDPR story simple.
   - **Create project**.
3. Top of the console → **Connect** → in the modal choose **Branch** `main` (production), **Database** `neondb`, **Role** the default owner.
4. Toggle **Connection pooling** **on**. The host now contains `-pooler`, e.g. `ep-xxxx-pooler.eu-central-1.aws.neon.tech`. Serverless functions open many short connections, so the pooled string is the one we use.
5. Copy the string (`postgresql://…-pooler…/neondb?sslmode=require`). Into Vercel as `DATABASE_URL` (Part 8).
6. Also copy the **unpooled** string (toggle pooling off) into Vercel as `DATABASE_URL_UNPOOLED`; migrations run through it.
7. Optional: Neon → **Integrations** → **Vercel** → connect the `syrup` project. This auto-creates a **Neon branch per Vercel preview deployment** with its own connection string, so PRs test against real schema. Free.

## Part 5 — PostHog (EU)

1. https://eu.posthog.com/signup (EU region; the URL matters). Create an org `syrup` and project `syrup`.
2. When asked for a framework, pick **Next.js**; skip the wizard's code (Phase 1 adds it).
3. Left menu → **Settings** → **Project** → **General** → copy **Project API key** (starts with `phc_`). It is safe to expose to browsers.
4. Into Vercel (Part 8): `NEXT_PUBLIC_POSTHOG_KEY` = that key, `NEXT_PUBLIC_POSTHOG_HOST` = `https://eu.i.posthog.com`.
5. Later (Phase 3, for server-side deletions): **Settings** → **Personal API keys** → create one scoped to this project → Vercel as `POSTHOG_PERSONAL_API_KEY`.
6. Recommended defaults now: **Settings** → **Project** → **Session replay** → enable, set **Mask all inputs** and **Mask all text**; **Data management** → keep autocapture on. **Sampling** can wait until traffic exists.

## Part 6 — Invites (who gets in)

Nothing to set up in a console. Two things to decide:
1. **Your admin Google account.** The email you sign in with becomes the first admin (allow-listed in code via `SYRUP_ADMIN_EMAILS`).
2. **The first invite list.** Any number of emails. Until the admin page exists (Phase 3), invites are seeded from `SYRUP_INVITES` (comma-separated) in Vercel env; after that, from the admin page. Sign-in with an email not on the list shows "invite only".

## Part 7 — Legal documents and the lawyer

Before Phase 4 goes public. Not needed for you and a handful of friends in Phase 1–3, but the drafts must exist because Google's Branding page links to them.

1. Drafts (Phase 1 ships them as pages): **Terms of Service**, **Privacy Policy**, **Research Consent** text, **Cookie notice** (essential cookies only). Start from a generator (Termly, iubenda, GetTerms, or Docracy templates), adapted to the retention schedule and subprocessor list in PLAN.md §6.
2. Questions to bring to the lawyer:
   - Correct **legal entity and jurisdiction** for the Terms (you personally vs. a company).
   - Whether an **EU representative (GDPR Art. 27)** is required if you are outside the EU/UK and serve EU users.
   - Sign-off on **consent unbundling**: service data under Terms, research use of content under separate opt-in.
   - **Retention schedule** and **DPA template** for business users.
   - Minimum **age** wording (16 EU / 13 US).
3. What to hand them: PLAN.md §6, the draft documents, the subprocessor list, and a one-paragraph description of what the product does.
4. Budget: a fixed-fee startup-terms review is typical. Ask for exactly that, not an hourly engagement.

## Part 8 — Environment variables in Vercel (all in one sitting)

Project → **Settings** → **Environment Variables** → **Add New**. For each: **Key**, **Value**, tick **Production** and **Preview** (and **Development** only where noted). Click **Save**. Redeploy once at the end (Deployments → ⋯ → **Redeploy**); env changes only apply to new deployments.

| Key | Value | Source | Notes |
|---|---|---|---|
| `SYRUP_MODE` | `cloud` | — | Local dev uses `local` in `.env.local`. |
| `AUTH_SECRET` | 32+ random bytes, base64 | run `npx auth secret --raw` or `openssl rand -base64 33` | Rotating it signs everyone out. |
| `AUTH_GOOGLE_ID` | Client ID | Part 3 E | |
| `AUTH_GOOGLE_SECRET` | Client secret | Part 3 E | Tick **Sensitive** so it can't be read back. |
| `DATABASE_URL` | pooled Neon string | Part 4 | Sensitive. |
| `DATABASE_URL_UNPOOLED` | direct Neon string | Part 4 | Sensitive. Migrations only. |
| `SYRUP_MASTER_KEY` | 32 random bytes, base64 | `openssl rand -base64 32` | Wraps every user's data key. **Back it up offline.** Losing it loses every stored provider key. Sensitive. |
| `SYRUP_ADMIN_EMAILS` | your Google email | Part 6 | Comma-separated if more than one. |
| `SYRUP_INVITES` | first invitees' emails | Part 6 | Temporary until the admin page. |
| `NEXT_PUBLIC_POSTHOG_KEY` | `phc_…` | Part 5 | Public by design. |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://eu.i.posthog.com` | Part 5 | |
| `NEXT_PUBLIC_APP_URL` | `https://syrup.syedsarib.com` | — | Preview deployments override automatically via `VERCEL_URL`. |

Not needed: `AUTH_URL` and `AUTH_TRUST_HOST` (Auth.js detects Vercel), any `VERCEL_*` variable (Sandbox authenticates with the deployment's OIDC token automatically).

**Local development** after this: run `npm i -g vercel`, then in the repo `vercel link` (choose the `syrup` project) and `vercel env pull` → writes `.env.local` including a 12-hour `VERCEL_OIDC_TOKEN` for local Sandbox calls. Re-run `vercel env pull` when it expires. `.env*` is already git-ignored.

## Part 9 — Check everything (5 minutes)

1. `https://syrup.syedsarib.com` loads over HTTPS with Vercel's certificate (padlock → certificate issued to the domain).
2. Vercel → Settings → Domains shows **Valid Configuration**.
3. Google Auth Platform → **Audience** shows **In production**.
4. Neon → project region shows an EU region; **Connect** with pooling shows `-pooler` in the host.
5. PostHog project URL begins with `https://eu.posthog.com/project/`.
6. Vercel → Environment Variables lists all 12 keys from Part 8 for Production and Preview.
7. GitHub → repo **Settings** → **Code security** → **Private vulnerability reporting**, **Dependabot alerts**, **Secret scanning** + **Push protection** all **Enabled** (Phase 0 adds `SECURITY.md` and branch protection).

When these pass, Phase 1 can deploy to the real domain on day one.
