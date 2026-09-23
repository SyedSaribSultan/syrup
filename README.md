# syrup

A self-hosted coding agent you run in your browser, powered by whatever API keys you already have.

No subscription. No single vendor. Bring keys from Google AI Studio, Groq, Mistral, OpenRouter, Cerebras, NVIDIA or any OpenAI-compatible endpoint. syrup routes work across them, tracks every token, and shows you exactly what each session cost.

## What it is

- **Engine:** [OpenCode](https://opencode.ai) runs the agent loop, tools, LSP, MCP, skills and context compaction. syrup drives it through its server API.
- **Web UI:** a Next.js app for sessions, diffs, permissions, questions, terminal, files.
- **Key vault:** add as many provider keys as you like. Stored locally, encrypted, never leave your machine.
- **Router:** spreads work across providers and keys, fails over on rate limits, prefers free tiers.
- **Cost dashboard:** tokens and dollars per message, session, provider and day. Free-tier usage shown separately from paid spend.
- **Memory:** long-term memory that persists across sessions, exposed to the agent as tools.

## Status

Early. Not usable yet. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for where this is going.

## Requirements

- Node 22+ (24 recommended), pnpm 10+
- OpenCode installed globally: `npm i -g opencode-ai`

## Development

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

## License

MIT
