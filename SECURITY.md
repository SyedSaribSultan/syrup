# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository (https://github.com/SyedSaribSultan/syrup/security/advisories/new). You will get a reply within 72 hours. Once a fix is out, we credit reporters who want credit.

## Scope and threat model

syrup runs a coding agent that reads, writes and executes code. Two modes exist:

**Local mode** (`pnpm dev` / `pnpm start` on your own machine)
- The agent runs with **your user's privileges**. Anything you can do, it can do. Treat it like a shell.
- The server binds to `127.0.0.1` only. Requests must carry a loopback `Host`, and mutating requests a matching `Origin`, which stops DNS-rebinding attacks from web pages you visit.
- The embedded OpenCode server and the router are protected by a per-process secret; other local processes cannot drive them.
- Provider API keys are encrypted at rest (AES-256-GCM). The key file lives in the user config dir (`%APPDATA%\syrup` or `~/.config/syrup`), outside any workspace, so the agent cannot read it by being pointed at your projects. **Do not** point the agent at your home or config directory.
- Skills are instructions the agent follows. Install skills only from sources you trust.
- Free OpenCode Zen models may use prompts for training; they are labelled in the model picker.

**Cloud mode** (`syrup.syedsarib.com`)
- Google sign-in, invite-only. Every request is authenticated.
- Each user's data is separated by `user_id` and Postgres row-level security.
- Provider keys are envelope-encrypted per user. They never touch a sandbox disk.
- The agent (from Phase 2) runs in an isolated microVM per workspace with an egress allow-list.
- See `docs/PLAN.md` §3, §4 and §6 for the full design and data handling.

Out of scope: vulnerabilities in the model providers you connect, in OpenCode itself (report those to https://github.com/sst/opencode), or attacks that require an already-compromised machine.

## Supported versions

The `main` branch. There are no maintained release lines yet.
