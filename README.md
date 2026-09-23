# syrup

A self-hosted coding agent you run in your browser, powered by whatever API keys you already have.

No subscription. No single vendor. Bring keys from Google AI Studio, Groq, Mistral, OpenRouter, Cerebras, NVIDIA, or any of 200+ providers. syrup routes work across them, fails over when a free tier hits its limit, tracks every token, and shows you exactly what each session cost.

## What you get

- **A full coding agent** in a clean chat UI: streaming replies, tool calls (read, write, edit, run, search), permission prompts, plan/build agents, subagents, LSP diagnostics, context compaction. The engine is [OpenCode](https://opencode.ai), the most-used open-source coding agent.
- **Workspaces.** Point it at any folder on your machine with the native OS folder dialog, or type a path. Chats are per folder.
- **Bring your own keys.** Add as many keys as you like per provider, label them, mark them free or paid. Keys are encrypted at rest and never leave your machine.
- **Router.** Pick **Auto** and syrup sends each request to the strongest connected model with tool calling and a large context, free tiers first, falling over on rate limits. **Fast** does the same for small tasks.
- **Cost dashboard.** Tokens and dollars per message, session, model and day. Free-tier usage is shown separately from real spend.
- **Long-term memory.** The agent saves and searches facts across sessions (SQLite + full-text search), exposed to it as MCP tools. You can edit everything it remembers.
- **Skills.** Install `SKILL.md` skills from GitHub or paste your own. Works with skills you already have in `~/.claude/skills`.
- **Attachments.** Drop or paste images and files into the composer.
- **Logs.** A structured application log (secrets redacted), one click away in the sidebar, with a copy-for-debugging button.
- **Optional `.sarib` tools.** In workspaces that contain [`.sarib`](https://github.com/SyedSaribSultan/sarib-lang) files, the agent can query and edit them by id instead of rewriting them. Other workspaces pay nothing for it. One click on the Skills page installs it.
- **Free out of the box.** OpenCode's free models work with no key at all, so you can try it before adding anything.

## Requirements

- Node 22+ (24 recommended) and pnpm 10+
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

1. Open **Providers** and add a key. Google AI Studio is free and takes a minute: <https://aistudio.google.com/apikey>.
2. Pick a folder with the workspace switcher at the top of the sidebar.
3. Start a chat with **Auto** selected.
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

- **Google AI Studio** — best free frontier model (Gemini Flash, 1M context, tools). Prompts may be used for training.
- **Mistral** Experiment tier — roughly 1B tokens/month incl. Devstral/Codestral. Data-training opt-in.
- **OpenRouter** — free models at 50 requests/day, 1,000/day after a one-time $10 top-up.
- **Groq** — free and fast, but 6k–12k tokens/minute. Agent turns are large; treat it as a "small tasks" provider.
- **NVIDIA NIM** — about 1,000 requests/day.
- **Cerebras** — no-card free tier ended mid-2026; $5 trial with a card.

syrup shows this next to each provider and lets you tag keys so the router knows what is free.

## Status

Working end to end, early. Things still rough: no theme toggle, no mobile layout, the router has been tested against real provider endpoints but not yet under sustained rate limiting. Issues and PRs welcome.

## License

MIT
