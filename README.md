# syrup

A coding agent in your browser, powered by whatever API keys you already have. Run it on your own machine (this README), or use the hosted early-access version at **https://syrup.syedsarib.com** (invite-only; see [docs/PLAN.md](docs/PLAN.md)).

No subscription. No single vendor. Start with free models that need no key, then bring keys from NVIDIA, OpenRouter, Mistral, Z.ai, Google AI Studio, or any of 200+ providers. syrup routes work across your keys, fails over when a free tier hits its limit, tracks every token, and shows you exactly what each session cost.

## What you get

- **A full coding agent** in a clean chat UI: streaming replies, tool calls (read, write, edit, run, search), permission prompts, plan/build agents, subagents, LSP diagnostics, context compaction. The engine is [OpenCode](https://opencode.ai), the most-used open-source coding agent.
- **Workspaces.** Point it at any folder on your machine with the native OS folder dialog, or type a path. Chats are per folder.
- **Bring your own keys.** Add as many keys as you like per provider, label them, mark them free or paid. Keys are encrypted at rest and never leave your machine.
- **Router.** **Auto** picks the best model for each chat from your keys. It sticks with that model for the rest of the chat, so prompt caches stay warm and answers stay consistent. If a model is rate-limited, overloaded or slow to start, syrup switches to the next one before any text reaches you, so you do not see the error. **Fast** does the same with quicker models and low thinking effort, for small tasks.
- **Model picker.** Auto and Fast come first, then your favorites, recent models and recommended ones. Everything else sits behind **All models**.
- **Cost dashboard.** Tokens and dollars per message, session, model and day. Free-tier usage is shown separately from real spend.
- **Long-term memory.** The agent saves and searches facts across sessions (SQLite + full-text search), exposed to it as MCP tools. You can edit everything it remembers.
- **Skills.** Install `SKILL.md` skills from GitHub or paste your own. Works with skills you already have in `~/.claude/skills`.
- **Attachments.** Drop or paste images and files into the composer.
- **Logs.** A structured application log (secrets redacted), one click away in the sidebar, with a copy-for-debugging button.
- **Optional `.sarib` tools.** In workspaces that contain [`.sarib`](https://github.com/SyedSaribSultan/sarib-lang) files, the agent can query and edit them by id instead of rewriting them. Other workspaces pay nothing for it. One click on the Skills page installs it.
- **Free out of the box.** OpenCode Zen's free models work with no key at all, so you can try it before adding anything. Pick one directly in the model picker; Auto and Fast need at least one key.

## Requirements

- Node 22+ (24 recommended) and pnpm 10+
- The local server listens on `127.0.0.1` only. Provider keys are encrypted with a key kept in `%APPDATA%\syrup` (Windows) or `~/.config/syrup`. See [SECURITY.md](SECURITY.md).
- Git (used to install skills from GitHub)
- OpenCode installed globally:

```bash
npm i -g opencode-ai
```

- Linux only: `zenity` or `kdialog` for the folder dialog (you can always type a path instead)
- Optional: Python 3.10+ for the `.sarib` tools (the Skills page installs the rest)

## Run it

```bash
git clone https://github.com/SyedSaribSultan/syrup.git
cd syrup
pnpm install
cp .env.example .env.local   # optional; defaults work
pnpm dev                     # http://localhost:3000
```

For a production build:

```bash
pnpm build
pnpm start
```

On first launch syrup starts an OpenCode server, the router and the memory server for you. Nothing else to configure.

## First steps

1. Open **Providers** and add a key. See [Which keys to add first](#which-keys-to-add-first). Auto and Fast route only across your keys.
2. Pick a folder with the workspace switcher at the top of the sidebar.
3. Start a chat with **Auto** selected. No key yet? Pick an OpenCode Zen free model in the model picker instead.
4. Check **Usage & cost** afterwards to see what it used.

## How it fits together

```
Browser (Next.js UI)
   │  /api/oc/*  (typed OpenCode SDK through a proxy)
   ▼
syrup server ── router :4210/v1 ── provider APIs (your keys)
   │            memory  :4210/mcp
   │            SQLite  data/syrup.db
   ▼
OpenCode server :4096  (agent loop, tools, LSP, MCP, skills)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture and the reasoning behind it.

## Configuration

Everything is optional. Copy `.env.example` to `.env.local` to change:

| Variable | Default | What it does |
|---|---|---|
| `OPENCODE_PORT` | `4096` | Port for the embedded OpenCode server |
| `OPENCODE_URL` | – | Attach to an OpenCode server you run yourself instead of spawning one |
| `SYRUP_ROUTER_PORT` | `4210` | Port for the router and memory MCP server |
| `SYRUP_WORKSPACE` | cwd | Default folder the agent works in |
| `SYRUP_DB` | `file:./data/syrup.db` | SQLite location |
| `SYRUP_VAULT_KEY` | auto-generated | 32-byte base64 key that encrypts provider keys. Generated into `data/vault.key` if unset |

Provider keys can also come from the environment (`GOOGLE_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, …). The router uses them when no key is saved in the vault.

## Free tiers, honestly

Free tiers change often. As of September 2026:

- **OpenCode Zen** — free models with **no key at all** (Big Pickle, Muse Spark 1.3, MiMo-V2.6-Flash, Space Bunny and more). Pick them directly in the model picker. Auto and Fast can't route them, because OpenCode limits its free tier to OpenCode itself. Free for a limited time; some use your prompts for training.
- **Google AI Studio** — best free quality: Gemini 3.8 Flash with 1M context. But the free tier is small: about **20 requests/day** for Flash, about 500/day for Flash-Lite. Quotas are per model and reset at midnight Pacific. Pro models are paid only. Prompts may be used for training.
- **NVIDIA NIM** — the largest free volume: about **40 requests/minute**, no published daily cap. Free Kimi K3, GLM-5.3, DeepSeek V4 and Nemotron. Terms say development and evaluation use.
- **OpenRouter** — one key, 20+ free models. **50 free requests/day** shared across all free models; 1,000/day after a one-time $10 purchase.
- **Mistral** — free plan with **$10 of API credits every month**, no card (phone verification). Devstral, Medium 3.5, Codestral. Turn off training in Privacy settings.
- **Z.ai** — GLM-4.7-Flash is free with no daily cap, one request at a time.
- **Cohere** — trial key with **1,000 calls/month**. Non-commercial use.
- **Groq** — very fast, but the free tier allows **8K tokens/minute**. One agent turn is often bigger than that, so syrup uses Groq only for quick side tasks.
- **Cerebras** — no free tier any more: a $5 trial with a card, 30K tokens/minute.

### Which keys to add first

OpenCode Zen works with no key, so you can start right away by picking one of its models directly. Auto and Fast need keys. Add them in this order:

1. **NVIDIA NIM** — the most free requests. <https://build.nvidia.com/settings/api-keys>
2. **OpenRouter** — many free models behind one key. <https://openrouter.ai/settings/keys>
3. **Mistral** — monthly free credits and good coding models. <https://console.mistral.ai/api-keys>
4. **Z.ai** — a free GLM model with no daily cap. <https://z.ai/manage-apikey/apikey-list>
5. **Cohere** — a small monthly trial allowance. <https://dashboard.cohere.com/api-keys>

A Google AI Studio key is still worth adding for its quality, but it runs out quickly on the free tier. The Providers page shows the same guidance next to each provider, and you can tag each key free or paid so the router knows what it costs.

## Hosted version

The same codebase runs as a hosted product at https://syrup.syedsarib.com (invite-only early access): Google sign-in, per-user encrypted keys, and each workspace's agent in its own isolated sandbox. Design and status: [docs/PLAN.md](docs/PLAN.md), [docs/PHASE2.md](docs/PHASE2.md).

## Status

Working end to end, early. Things still rough: no theme toggle, no mobile layout, the router has been tested against real provider endpoints but not yet under sustained rate limiting. Issues and PRs welcome.

## License

MIT
