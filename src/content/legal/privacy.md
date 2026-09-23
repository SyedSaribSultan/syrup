> **Draft, version 2026-09-23.** Not yet reviewed by a lawyer. Items in [brackets] are placeholders. This policy explains what syrup.syedsarib.com collects and why, in plain language. We wrote it to be read.

## 1. Controller

**[Legal entity or full name]**, **[address]**, **[country]**, is the controller of your personal data. Contact: **sadakhan2002@gmail.com**. **[EU/UK representative, if required under GDPR Article 27: name and address]**.

## 2. The short version

- We store what is needed to run the service for you: your account, your workspaces, your chats with the agent, your encrypted provider keys, usage and cost records, memory and skills. Basis: the contract between us (the Terms).
- We collect anonymous product analytics about how the app is used (which features, how often, which errors), never the content of your prompts or code. Basis: legitimate interest. You can turn this off in Settings.
- We use the **content** of your conversations for research and to improve syrup **only if you switch that on** in Settings. Basis: your explicit consent, which you can withdraw at any time.
- You can export or delete everything from Settings.

## 3. What we collect, why, and for how long

### 3a. Service data (needed to run syrup)

| Data | Why | Kept |
|---|---|---|
| Google account id, email, name, profile picture | Sign-in, showing who you are | Life of the account |
| Workspaces (repository URL, name, settings) | Running the agent where you asked | Life of the account, or until you delete the workspace |
| Chat sessions and messages, including the agent's tool calls and results | Showing your history, resuming work, computing usage | Life of the account, or until you delete them |
| Attachments you add to chats | Same | Same |
| Provider API keys, **encrypted** | Making the model requests you start | Until you remove them |
| Usage and cost records per message | The usage dashboard, failover decisions | Raw records 13 months, then aggregated |
| Memory the agent saves and skills you install | The features you asked for | Life of the account, or until you delete them |
| Consent records (which version you accepted, when, a hashed IP, browser string) | Proving what you agreed to | 6 years after withdrawal or account deletion |
| Audit log (key added or removed, sign-in, export, deletion, consent changes) | Security and accountability | 2 years |
| Technical logs (errors, timings; secrets redacted) | Keeping syrup running | 14 days |

Legal basis: performance of a contract (GDPR Art. 6(1)(b)); for consent and audit records, our legal obligations and legitimate interest in security (Art. 6(1)(c), (f)).

### 3b. Product analytics (understanding how syrup is used)

We use **PostHog** (EU-hosted) to record events such as "signed in", "created workspace", "sent message", "sandbox started", feature usage, page views, error types, and timing. We also record session replays of the interface **with all text and inputs masked**, so prompts, code and keys never appear in a recording.

We do **not** send prompts, replies, file names, file contents, keys or memory contents to analytics.

Legal basis: legitimate interest in improving the product (Art. 6(1)(f)). **You can opt out** in Settings → Privacy, and we honor the browser "Do Not Track" signal.

### 3c. Research data (only with your consent)

If you turn on **Research Data Consent** in Settings, we may use the **content** of your conversations with the agent (prompts, replies, tool calls, results, and whether you accepted or reverted the agent's changes) to:

- evaluate and improve routing, prompts, and the agent's behavior;
- build anonymized datasets and publish aggregate findings.

Before research use we remove secrets, emails and IP-like strings, and we never publish anything that identifies you or your code. This consent is **off by default**, is **not** a condition of using syrup, and can be **withdrawn** at any time in Settings. Withdrawal stops future use and removes your content from research datasets we control.

Legal basis: consent (Art. 6(1)(a)). See the Research Data Consent document for the exact wording you agree to.

## 4. Who else sees your data (subprocessors)

| Provider | What | Where |
|---|---|---|
| Vercel Inc. | Hosting of the web app; isolated sandboxes that run the agent | EU (Frankfurt) for functions and database region; sandboxes in Vercel regions |
| Neon Inc. (via Vercel) | Postgres database | EU (Frankfurt) |
| PostHog Inc. | Product analytics (see 3b) | EU |
| Google LLC | Sign-in with Google | Google's regions |
| Cloudflare Inc. | DNS for our domain (no traffic proxying) | Global |
| The AI model providers **you** connect (e.g. Google AI Studio, Mistral, OpenRouter, Groq) | Receive the prompts and code the agent sends on your behalf | Each provider's own regions and terms |

We update this list when it changes.

## 5. International transfers

Our core storage is in the EU. Some subprocessors (Vercel, Google, PostHog for support) may process data in the United States under standard contractual clauses or the EU-US Data Privacy Framework. The model providers you connect process data wherever they operate; check their policies.

## 6. Your rights

You can, at any time and free of charge:

- **Access and export** all your data (Settings → Privacy → Export). You receive a download link by email within a few days at most.
- **Correct** your profile (it comes from Google; change it there).
- **Delete** your account and data (Settings → Privacy → Delete account). Your account is deactivated immediately; sandboxes and their snapshots are destroyed; all records are permanently erased within **30 days**, except consent and audit records we must keep, and backups which expire within a further 30 days.
- **Object** to analytics (opt out in Settings) or **withdraw** research consent (Settings).
- **Complain** to your data protection authority. We would appreciate the chance to help first: sadakhan2002@gmail.com.

## 7. Security

Transport is encrypted (TLS). Provider keys are encrypted with a key unique to your account, itself encrypted with a master key we hold. Keys are never written to the disk of the environment that runs the agent. Your data is separated from other users' data by database row-level security. The agent runs in an isolated micro-VM per workspace with restricted network access. We publish our security practices at https://github.com/SyedSaribSultan/syrup/blob/main/SECURITY.md.

No system is perfectly secure. If a breach affects you we will tell you without undue delay, and within 72 hours where the law requires.

## 8. Cookies

We use only cookies that are strictly necessary (your sign-in session and CSRF protection) plus an analytics identifier that you can disable in Settings. There is no advertising or cross-site tracking. See the Cookie Notice.

## 9. Children

syrup is not for children under 16. We do not knowingly collect their data; tell us and we will delete it.

## 10. Changes

We will announce material changes in the app or by email before they take effect. The version you last accepted is recorded in your account.

## 11. Contact

sadakhan2002@gmail.com
