# Rendering

Status: **contract for ROADMAP rounds 2–8, judged 2026-10-07.** Implementing agents build from this file. [ROADMAP.md](ROADMAP.md) keeps the decisions and the status table; where this file changes an agreed plan item, §8 says which and why. Change this file, not chat.

Sources: three designs (lean, robust, fast), the five spikes of 2026-10-07 (opencode-tools, sandbox-ports-origin, libraries, nextjs-16, ui-integration), and checks against the code at `e64efc4` (the harness commit), plus Round 1's uncommitted router work for the repair leash. Re-judged 2026-10-08: the repair leash now follows ROADMAP decision 16 exactly, package files are disjoint, every round names its dependencies and weight check. Revised 2026-10-08 after an independent critique: streaming belongs to the agent already building it (2a builds on it), Round G waits for the proxy's redaction change, agent markup is clipped as well as shadowed, the export, repair, Mermaid-converter, tool-schema, live-preview and harness gaps it found are closed, and rejected points are listed in §7.

Related: [ROADMAP.md](ROADMAP.md) (the rounds), [TESTING.md](TESTING.md) (the gate and the harness), [CAPABILITIES.md](CAPABILITIES.md) (the research), [ARCHITECTURE.md](ARCHITECTURE.md) (what exists).

---

## 0. Needs the founder

**Blocking, Round 5 cloud only:**

1. ~~May Claude create the Vercel project `syrup-preview` and deploy the preview shell to `syrup-preview.vercel.app`?~~ **Yes (founder, 2026-10-08).** Hobby plan, $0, Standard Protection. It replaces ROADMAP §4's DNS record (§6, step I1).

**Not blocking: plan items this contract changes.** Veto any of them by editing §1 here; details in §8.

- **Round 2a waits for the streaming change** that another agent is building now (`message.part.delta` in `engine-store.tsx`, uncommitted). 2a builds on it and does not write its own.
- **Round G waits for the secret-redaction change** in `src/app/api/oc/[...path]/route.ts` (another agent's, uncommitted), then edits only the header handling there.
- **A repaired diagram is written back into the chat**, so shares and the next turn see the fix. The original stays in the part's metadata.
- **Automatic repair only for replies that ended in the last 10 minutes.** An older broken diagram shows its source with **Try to fix**, so reading history never spends quota.
- **Round 3 checks Vega-Lite with a lint plus Vega's own errors**, not the published JSON schema.
- **Round 5's preview origin is `syrup-preview.vercel.app`** (another site), not `preview.syedsarib.com` (the same site as the app).
- **Round 5's iframe also allows forms and modals**, and its CSP lets pages load scripts and styles from five CDNs and fonts from Google Fonts (images and fetches: esm.sh only).
- **Round 7's tools are MCP tools** on syrup's existing MCP server, not an OpenCode plugin.
- **Round 8 adds sandbox ports on demand** (up to 15), and locally frames the dev server's own address instead of proxying it.
- **Round 8 counts against Vercel Sandbox Data Transfer.** Everything served through an exposed sandbox port is metered. Hobby includes **20 GB a month**; past that, sandbox creation pauses for every user until the cycle resets. Unbundled dev servers (Vite) are the heavy case. Round 8 caps exposure (a port closes when its preview closes or after 15 minutes without a reload); watch the usage page after it ships.

**Restarts of `pnpm dev` (owner: founder, §6 I4):**

- **Rounds 2b and 7: before the push.** The bench must measure the new router code and the new tools, and both load only after a restart. Claude asks, waits, then runs the "after" bench.
- **Every other round from 2a on: after the push**, so the local engine picks up the new prompt lines (Round 5 also starts the preview listener).

---

## 1. Decisions

| # | Topic | Decision | Why | Rejected |
|---|---|---|---|---|
| 1 | Order | **Round G (local origin guard) ships first among rounds 2–8, alone, once the redaction change in `src/app/api/oc/[...path]/route.ts` is committed by its owner.** It touches no router file, so it may land before, after or beside Round 1. Then 2a (once the streaming change is committed, decision 6), 2b, 3, 4, 5, 6, 7, 8, one push each. If Round 1 is late, Round 3 may push before 2b (§3.3). | The spike verified live that any page on a loopback port can read `/api/oc/*`; Rounds 5 and 8 put agent pages on loopback ports. Round 2 is about three days, so it is split (ROADMAP: "split, not stretched"). | Guard inside Round 5 (leaves the hole open a week); Round 2 as one push. |
| 2 | Registry | **One data table, one lazy core.** `kinds.ts` maps fence languages, file names and tool ids to a `RichKind`. Fences, Preview files, tool parts and panel blocks all build one `RichInput` and render through the core: `RichBlock` (chat), `RichView` (panel), `prerenderForExport` (HTML file). A new kind is one table row, one `Renderer` module and one loader line. | Same behaviour on every surface; one place per kind; each lane adds kinds in its own files. | A component per kind with an `onSettle` callback (lean): no static/interactive split, and the export can't reuse it. |
| 3 | Loading | **The main chunk holds only the stub:** kinds, the fence rule, the slot and the loader maps (≤ 1.5 KB gz). The core and every renderer are `import()` chunks read through `useLazy` (`useSyncExternalStore`, server snapshot `null`). `next/dynamic` only for panel-only views and the Preview tab. | `next/dynamic`'s `loading` receives fixed props, so it can't draw a kind-shaped skeleton. `ssr: false` would put skeletons, not code, into shared-chat HTML. Each literal `import()` is still its own chunk. | `next/dynamic` per renderer (ROADMAP §2 wording; its intent is kept: lazy, first use, idle prefetch); `useEffect` + `import()` (lean: flashes a fallback even when loaded). |
| 4 | Weight payback | **The Preview tab (`FilePreview`, `highlight.ts`, `html-inline.ts`) becomes a `next/dynamic` chunk** in Round 2a. | It ships on every chat route while the panel is closed. Moving it out pays for the stub, so initial JS stays flat. | Re-baselining the weight check. |
| 5 | Fence lifecycle | **A fence renders when `closed \|\| final`.** `closed`: the spike's rule on the `pre` node's source slice. `final`: `settled && typed.length === text.length`, where `settled = !streaming \|\| time.end` and `streaming` is MessageView's prop (busy and the last assistant message). The typewriter's own `live` flag stays separate. An open fence shows a fixed-height skeleton and is never parsed. | Never parses half-typed input. `settled` also covers aborted turns, which never get `time.end`: `streaming` goes false when the session goes idle, while the typewriter's `live` does not. | `time.end` only (an aborted reply keeps its skeleton forever); `settled` from the typewriter's `live` (same failure). |
| 6 | Streaming | **Round 2a depends on the streaming change (owner: the agent now editing `engine-store.tsx`) being committed; 2a builds on its API.** What 2a relies on: deltas apply only to parts whose opening (empty) `message.part.updated` arrived over the open stream (the owner's per-page watched set, `live` in the working tree); the set clears on reconnect; a part joined mid-stream shows the Writing indicator until its final `message.part.updated`. So `FenceSlot` never sees text that starts in the middle of a reply. | The owner is building and testing it now, with harness support (`partStart`, `partDeltas`, `partEnd`, `text(…, { open, later })`). A second reducer here would collide with it. Appending deltas to a part fetched mid-stream would show the tail of a reply as if it were whole, and turn its closing fence into an opener. | This contract's earlier package 2a.stream (a 100 ms buffered reducer in `part-deltas.ts`): duplicate work on files another agent owns, and wrong for a page that joins mid-stream. |
| 7 | Parsing | **One react-markdown parse per typewriter frame, as today.** Rich blocks are memoized by source hash and rendered once. | No round needs more; the typewriter already re-parses per frame. | A block splitter with a golden equivalence test (fast): risk on every chat for a gain nothing requires. |
| 8 | Math | **A lazy math chunk:** remark-math 6, the Pandoc dollar guard, and a code-aware normalizer that turns `\(…\)` into `$…$` and `\[…\]` into `$$…$$`. It loads the first time a text contains `$`, `\(` or `\[`. `$$…$$` blocks use the fence closure rule. KaTeX 0.19 renders through `TexSlot`. | Keeps the main chunk flat. `$5 and $10` stays prose. Weak models write `\[…\]`, which Markdown escaping destroys before any plugin runs. | rehype-katex (main chunk, pins KaTeX 0.16, whose `underline` class collides with Tailwind); `singleDollarTextMath: false` (drops ROADMAP's `$…$`). |
| 9 | Agent SVG | **Our own DOMPurify instance with URL and CSS hooks (§2.12), mounted in an open shadow root inside a light-DOM clip** (`.rich-clip`: `contain: layout paint; overflow: hidden; position: relative; isolation: isolate; max-height: 600px`); a light "paper" card in dark mode. The same path serves ```` ```svg ```` fences and `.svg` files in the live app. **Read-only views** (`/c/[id]`, the export) render kind `svg` as `<img src="data:image/svg+xml;base64,…">` of the sanitized markup, inside the same clip. | ROADMAP R2 and R4. The spike measured an agent `<style>` restyling the whole app without a shadow root. A shadow root isolates selectors, not layout: the critique's Chromium test (`research/critique/overlay.mjs`) had a `:host{position:fixed!important;inset:0!important}` rule cover the whole viewport until the clip confined it. In read-only views the picture is static anyway, and an `<img>` has no script, fetch or overlay surface for a stranger's link. | `<img>` in the live chat (lean): contradicts R2 ("inline sanitized") and R4 ("real SVG instead of `<img>`"); no text selection, links or theme. A shadow root alone (overlay). |
| 10 | Mermaid | **11.17.2 with `securityLevel: "strict"`, the `base` theme fed from the app's tokens,** a locked `secure` list, `logLevel: "fatal"`, `mermaid.render` to a string, an outer DOMPurify pass with the agent-SVG CSS hooks, a shadow root inside the clip. **Every use of the Mermaid singleton goes through the renderer's queue** (`runWithMermaid`, §3.2a), the Excalidraw converter included; after a foreign `initialize` the renderer re-initializes before its next render. | One Mermaid shared with the Excalidraw converter, which calls `mermaid.initialize` with its own config (`dist/parseMermaid.js:64`) and runs its own queue. Strict mode, the outer pass, the clip and the shadow root are defence in depth for markup on the app's origin. | Mermaid 12 (ELK default +464 KB; a second Mermaid next to the converter); `@probelabs/maid` (fixed 5 of 12 cases, broke valid diagrams); letting the converter call Mermaid on its own (wrong theme and size, error SVGs and logs back, overlapping renders). |
| 11 | Vega-Lite | **No JSON schema.** `JSON.parse`, a zero-dependency lint, `compile` with a capturing logger, a `View` (renderer `none`, `vega-interpreter`, deny-all loader), `toSVG()`, then the SVG sanitizer. Main thread, idle queue. | Schema plus ajv is 142–179 KB gz, compiles in 0.8 s, and still misses the commonest error (a field not in the data). The interpreter keeps agent expressions away from `Function()` on the app's origin. | The JSON schema (ROADMAP R3 wording); codegen expressions; a Web Worker (fast: label metrics unverified; revisit if the Round 3 perf report asks for it). |
| 12 | Tables | **TanStack Table v9 + TanStack Virtual** (ROADMAP R3): sortable, virtualized past 200 rows, formula-safe **Copy CSV**. Compact screens show 20 rows plus **Open table (N rows)**; wider screens scroll inside 420 px. JSON fences become tables only when closed and shaped like records, with a Table · JSON toggle. GFM tables wider than 8 columns become rich tables once final. | The roadmap names TanStack. No scroll trap on phones, and sorting still works inline. | An own 150-line table (lean); an inner vertical scroller on phones. |
| 13 | Mind maps | **`markmap-view` plus our own mdast-to-tree builder** (labels escaped): static in the chat, interactive in the panel. | 26 KB beyond the parser syrup already ships. | `markmap-lib` (237 KB, fetches plugins from a CDN). |
| 14 | Cache and queue | **A memory LRU of 200 entries** keyed `kind@version\|scheme\|widthBucket\|hash`, single-flight; the old picture stays until a new theme or width render is ready. **One render at a time** in an idle-time queue, with a 20 s render timeout; a timed-out render keeps its queue slot until it settles (at most 20 s more), because a Mermaid render can't be aborted. | Typewriter frames re-render the message; each block must cost nothing after its first render. | An IndexedDB cache (fast: privacy, sign-out clearing, more code); IntersectionObserver gating (fast: off-screen blocks would never settle for the harness or the export). |
| 15 | Repair transport | **A hidden child session over the engine's HTTP API**, identical in local and cloud: create it with `parentID` and title `syrup:repair`, prompt a tool-less hidden `repair` agent on `syrup/fast` synchronously, delete it in `finally`. | The engine is the only model path the browser reaches in both modes. OpenCode serializes snapshots per git dir (`snapshot/index.ts`, one-permit semaphore), so the child can't corrupt the turn's snapshot. | A scratch folder (fast: boot work and path plumbing for a race that doesn't exist); a new `syrup/repair` alias (robust: new picker, label and backend entries). |
| 16 | Repair spend | **The router recognizes a repair call by its fixed prompt (as it does titles) and takes Round 1's title path:** one backend, 4 s to the first token, no failover, a detached session (no stickiness), then a quiet HTTP 400 `syrup_repair_skipped`. On top of the title path: free, non-scarce candidates only, at most 2,048 output tokens, `temperature: 0`, and the system message replaced by `REPAIR_PROMPT` alone before the upstream call. | ROADMAP decisions 8 and 16: one hidden Fast call, "4 s deadline, then skip". A call the user never sees must never spend. OpenCode's system message for any agent also carries the env block, the `instructions` (the local MEMORY.md index) and the workspace `AGENTS.md`: sending that on every repair costs free-tier TPM, ships the memory index out, and lets repo text steer the fix. | Plain Fast routing (it may land on a paid key); a second attempt (contradicts decision 16's "then skip"). |
| 17 | Repair policy | **Autofix first:** deterministic Mermaid and JSON fixes, run everywhere, read-only views included. **Then one model call per source:** automatic only for replies that ended ≤ 10 minutes ago (≤ 3 per message), started only when no session in the directory is busy, aborted (and requeued as **Try to fix**) the moment one becomes busy, single-flight across tabs. Older replies get **Try to fix**. Files are never repaired silently. | Silent and once (decision 8), without spending quota when someone merely reads history. The repair child takes a git snapshot (413–578 ms on Windows) and OpenCode serializes snapshots per git dir, so a repair in flight would delay the user's next first token (ROADMAP §2: no round makes it later). | Repairing history on view; per-session hourly budgets (robust; freshness covers them). |
| 18 | Repair persistence | **The fix is written back into the text part** with a PATCH, once the part has ended, the session is idle and the original block is still there verbatim. The original is kept in `metadata.syrup.repairs`. Fixes, and failures for 7 days, are also memoized in localStorage. | Shares, the export, other devices and the next turn see the fixed block; no call is ever repeated. | A browser-only memo (lean); a visible `%% fixed by syrup` marker (fast). |
| 19 | HTML export | **Collect, then prerender, then embed.** A first `flushSync` pass collects the rich inputs; renderers produce static markup in the light theme (`LIGHT_TOKENS`); a second pass embeds it. SVG-like kinds go in as declarative shadow DOM on a paper card, emitted as `<template shadowrootmode="open" dangerouslySetInnerHTML={{ __html: css + markup }} />` (kind `svg` as an `<img>` data URL, decision 9); math as MathML only, tables as static HTML (≤ 500 rows), chart data under `<details>`, the source under every visual, no `<script>`. Renderer stylesheets are not inlined. | `flushSync` alone misses lazy output. `innerHTML` can't serialize a live shadow root, but it keeps a `<template shadowrootmode>` verbatim. React puts `<template>` children into the element, not into `template.content`, so they serialize as nothing; `dangerouslySetInnerHTML` fills `.content` (verified with React 19.2.8 in Chromium, `research/critique/run.mjs`). `readTokens()` reads the page's current scheme, so a dark page would draw dark pictures on the light card. MathML needs no fonts. | Offscreen render-and-settle (lean: loses shadow content); KaTeX HTML plus woff2 fonts in the file. |
| 20 | Read-only views | **`/c/[id]` server-renders code blocks; visuals replace them after hydration.** Autofix runs, model repair doesn't. **Open** becomes a lightbox. Previews never run. Tool payloads render. | No-JS readers and crawlers get the source. Nothing from a stranger's link runs code. | Skeletons in the server HTML (lean). |
| 21 | Phones | **A static picture in the chat, the interactive version in the panel layer.** Tapping a picture opens it. No iframe ever enters the chat column. Panel actions that prefill the composer close the layer first. | ROADMAP §2. The chat is `inert` under the panel layer. | Interactive charts inline on phones. |
| 22 | Files | **`fileKind` plus JSON sniffing in the Preview tab.** MapLibre with a blank style by default and an opt-in OpenFreeMap basemap; Excalidraw view mode with every font self-hosted; a hand-rolled notebook view (anser for ANSI colours, HTML outputs sanitized in a shadow root). A broken file shows its error and **Ask the agent to fix**. | ROADMAP R4. No third-party request unless the user turns on a basemap. Files change only through the agent or the user. | Vega `geoshape` for maps (lean; contradicts R4); Latin-only fonts (CJK text falls back to esm.sh); notebook HTML in iframes. |
| 23 | Preview origin | **Cloud: a separate static Vercel project on `syrup-preview.vercel.app`. Local: a loopback listener on 127.0.0.1:4211.** Both serve the same `preview-shell/index.html` with headers from one `preview-shell/vercel.json`. | `vercel.app` is on the Public Suffix List, so the preview is another site, and nothing of the app lives there. | `preview.syedsarib.com` (same site: CSRF, cookie tossing, PostHog cookie exposure); host routing inside the app project. |
| 24 | Preview runtime | **A nonce-checked postMessage protocol (v1).** Iframe `sandbox="allow-scripts allow-forms allow-modals"`. React and the allow-listed libraries come from esm.sh through an import map; sucrase from esm.sh loads only for React. The CSP lets scripts and styles reach five CDNs (fonts also Google Fonts); images and fetches reach esm.sh only, besides `data:` and `blob:`. Navigation is caught by a ping after every `load`. | ROADMAP R5 says esm.sh. Real pages use Tailwind's CDN and CDN libraries. Arbitrary image hosts would be a beacon channel, and so would unpkg and jsDelivr images (anyone can publish files there, and jsDelivr publishes per-file hit statistics). | React bundled into a committed shell build (robust); `img-src https:` (lean); images and fetches from all five CDNs (beacon channel); counting `load` events (differs between browser engines). |
| 25 | Excalidraw save | **`op=write` on both file routes:** existing files only, atomic temp file plus rename, a `sha256` precondition (409 with the current hash), symlinks refused, 5 MB local and 4 MB cloud. The editor loads exact bytes (`op=raw`). New drawings go through the existing `upload` op. | Nothing can overwrite a file today. Cloud `file.read` trims text, so hashes need exact bytes. | Hashing trimmed text (lean); a create mode on `write` (robust, fast). |
| 26 | Structured tools | **MCP tools on syrup's existing MCP server:** `show_chart`, `show_table`, `show_diagram` and `ask_form`, which OpenCode names `syrup_*`. zod-validated, short text output. The UI renders from the tool input once the output says "Shown to the user". `ask_form` is non-blocking: the answers arrive as the next user message. | A plugin makes OpenCode npm-install into every config dir (21–28 s on the first request) unless each one is pre-seeded, including the user's real `~/.config/opencode` and any repo `.opencode/`; plugin arguments are never validated. MCP code already runs locally and in the sidecar. Answers as the next message is ROADMAP R7's own wording. Schemas stay flat (strings, string arrays, no unions, no open records) because several free backends reject or mangle `anyOf` and `additionalProperties`, and MCP tools ride on every request. | An OpenCode plugin (ROADMAP R7 wording; robust); the built-in `question` tool as `ask_form` (lean: held in memory and lost when a sandbox sleeps; no field types). |
| 27 | Live preview | **Ports on demand:** `sb.update({ ports: [4096, …up to 3 recent, port] })`, skipped when the port is already routed, reset to `[4096]` whenever the engine restarts, and **closed again** when its LiveFrame closes or after 15 minutes without a reload. Locally the iframe loads `http://localhost:<port>/` directly. Detection reads the bash command plus its live and final output; a probe classifies up, down, blocked host and asleep. | 15 ports, live updates and stable URLs are verified. Proxying through `:3000` would run agent code on the app's origin (decision 7). Port traffic is metered Sandbox Data Transfer (20 GB a month on Hobby, then sandbox creation pauses for everyone), so a port is open only while someone looks at it. | Ports declared at create (ROADMAP R8 wording); a local proxy route; a server-side TCP probe route (robust). |
| 28 | Dependencies | **Installed once, up front, with exact pins** (§3.0). | One lockfile writer; later rounds never touch it. | Installs per round. |
| 29 | Proof | **Every round:** harness fixtures asserting `data-rich-*` at 390 and 1440 px (plus WebKit for the round's scenarios), unit suites, `ui:weight --compare`; `--budgets` from Round 2a (it lands there as W1), `--perf` from Round 3 (W2). | ROADMAP decision 19, made exact. Today `scripts/js-weight.mjs` throws "Unknown argument" for `--budgets` and `--perf`. | Screenshots judged by eye only. |
| 30 | Working beside other agents | **A package starts with `git status --short` and stops if any file it owns is listed** (another agent's uncommitted work). The harness and `ui:weight` run only in the main checkout, only when `git status` lists no file outside the round. Worktrees run typecheck, ESLint and the node unit suites only. | The harness drives the one shared dev server, which serves the main tree, other agents' half-done edits included; `ui:weight` runs `next build`, which type-checks the whole tree. | Running the harness from a worktree (it would test the main tree); a second dev server on the default ports (a second router on 4210, engine on 4096). |

---

## 2. Architecture

### 2.1 Facts this rests on

| Fact | Source | Consequence |
|---|---|---|
| A text part is stored empty when it starts; its text arrives only as `message.part.delta`; a GET mid-stream returns the part empty and nothing replays the deltas | ui-integration spike | A part joined mid-stream must not grow from deltas (decision 6) |
| Another agent is adding delta support now, uncommitted: in the working tree on 2026-10-08, `engine-store.tsx` has a `deltas` action and a `live` set of parts watched from their start, `PartView` passes `TypedText` `{ text, live: open && live }`, `useTypewriter(text, live)` lost its `endedAt` argument, `session-view.tsx` follows growth with a `ResizeObserver` while busy; the harness has `partStart`, `partDeltas`, `partEnd`, `openParts` and `text(…, { open, later })`, and `openingEvents()` replays no deltas | `git status`, `git diff` | Round 2a builds on that change once it is committed and writes against whatever API it commits (decision 6) |
| The `pre` override gets `node.position`; an open fence runs to the end of the text; the language can be a prefix while the info line types | ui-integration spike | Kind is decided only after the info line's newline |
| An unclosed `$$` renders as `pre > code.language-math.math-display` to the end of the text; `\[ … \]` loses its backslashes in parsing | robust design's probes | `$$` uses the closure rule; normalize before parsing |
| `EngineProvider` builds a new context value on every dispatch | code | Rich blocks are memoized by source hash and cached (decisions 7, 14), so a re-render costs nothing after a block's first render |
| OpenCode serializes snapshot operations per git dir | `packages/opencode/src/snapshot/index.ts` (Semaphore, 1 permit) | The repair child may share the workspace folder |
| `GET /agent` lists hidden agents; the synchronous prompt returns `{info, parts}`; `PATCH …/part/:partID` accepts any full part whose ids match; `TextPart` has `metadata` | spike proof files; OpenCode source `handlers/session.ts:397`, `schema/v1/session.ts:102` | Capability check and write-back |
| `permission: "deny"` removes every tool, MCP included; `hidden` alone does not hide a subagent from the task tool | opencode-tools spike | Repair agent config |
| The router already knows a title call by OpenCode's fixed text (`isTitleCall`) and leashes it | `src/server/router/core.ts`, `policy.ts` | Repair calls are recognized the same way |
| A plugin makes OpenCode npm-install into every config dir (21–28 s on the first request) unless each one is pre-seeded, including the user's real `~/.config/opencode` and any repo `.opencode/` (pre-seeded, the first request took 0.29 s); plugin arguments are never validated; MCP tools are keyed `syrup_<name>`; `handleMemoryMcp` builds the MCP server both locally and in the sidecar | opencode-tools spike; `src/server/memory/tools.ts` | Decision 26 |
| An agent's system message is the agent prompt, the env block, the `instructions` (local MEMORY.md index) and the workspace `AGENTS.md`; custom models drop `temperature` | opencode-tools spike | The router rewrites a repair call's system message (decision 16) |
| A shadow root isolates selectors, not layout: an inner `:host{position:fixed!important;inset:0!important;z-index:2147483647!important}` beats the outer `position:relative` and covers the viewport; a light-DOM `contain: layout paint; overflow: hidden` wrapper confines it. CSS `image-set("https://…" 1x)` fetches without `url(`, from a `<style>` rule and from a `style` attribute | critique's Chromium tests (`research/critique/overlay.mjs`) | `.rich-clip` and the CSS hooks (§2.12) |
| React puts `<template>` children into the element, not `template.content`; `innerHTML` then serializes `<template shadowrootmode="open"></template>`. With `dangerouslySetInnerHTML` the content survives, and React logs no error for `shadowrootmode` | critique's Chromium test with React 19.2.8 (`research/critique/run.mjs`) | `RichExport` uses `dangerouslySetInnerHTML` (§2.9) |
| `@excalidraw/mermaid-to-excalidraw` 2.2.2 calls `mermaid.initialize(mergedConfig)` on the shared singleton (default theme, 20px font, `maxTextSize` 50000, `suppressErrorRendering` and `logLevel` reset) and runs its own queue | `dist/parseMermaid.js:64`, `mermaidExecutionQueue.js` | The converter runs inside syrup's Mermaid queue (§3.6) |
| `parseMermaidToExcalidraw` returns `{ elements, files }`; non-native diagram types keep their picture in `files`; `api.updateScene` takes no files | `@excalidraw/mermaid-to-excalidraw`, `@excalidraw/excalidraw` types | Files are serialized and added with `api.addFiles` (§3.6) |
| Next 16 refuses dev-only assets and HMR to origins other than localhost and the start hostname unless `allowedDevOrigins` lists them (no-cors script loads are matched by Referer) | `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/allowedDevOrigins.md` | An agent's Next app through `*.vercel.run` needs `allowedDevOrigins` (§3.8) |
| Exposed sandbox port traffic is Sandbox Data Transfer: 20 GB a month on Hobby, then sandbox creation pauses until the cycle resets | sandbox spike | Ports close when unused (decision 27) |
| `src/proxy.ts`'s matcher skips static extensions but not `mjs`, and `PUBLIC` has no `/vendor` | code | Round 4 adds `/vendor/` to `PUBLIC` (§3.4) |
| `scripts/js-weight.mjs` accepts `--compare`, `--update`, `--no-build`, `--scenarios` only; `scripts/bench-agent.mjs` drives the running dev server on 127.0.0.1:3000 | code | `--budgets` from 2a, `--perf` from 3; the after-bench needs a restart first (§3.0) |
| A running tool part carries its full input; `output` is cut at 50 KB; `clipForViewer` replaces inputs over 6,000 characters with a note | spike; `src/lib/transcript.ts:509` | Tool payloads come from the input; the clip limit rises for UI tools |
| Sandbox: up to 15 ports; `update({ports})` works live and replaces the list; `getOrCreate` ignores ports; resume keeps ports and URLs, not processes; port URLs are public | sandbox spike | Decision 27 |
| `vercel.app` and `vercel.run` are on the Public Suffix List; `syedsarib.com` is not | sandbox spike | Decision 23 |
| `share-export.ts` reads `innerHTML` right after `flushSync`, and inlines every stylesheet's fonts up to 2 MB | code | Decision 19 |
| The harness waits for no `[aria-busy]` in `.chat-log` once, at page load; after steps it waits for `document.body` text length and element count to stop changing, which ignores shadow-root content; any console error fails; other origins are blocked; an unmocked `/api` request fails | `scripts/ui-harness.mjs` | `aria-busy` only while a block is loading; H10 waits for it after steps too; expected failures never `console.error` |
| Playwright's CSS selectors pierce open shadow roots | Playwright docs | Assertions can reach into rendered SVG |
| MapLibre's worker and Excalidraw's font-subset worker break under Turbopack (`file:///ROOT`) | libraries spike | Copy the worker and fonts into `public/vendor/` |

### 2.2 Layers and the registry

```
 fence (markdown.tsx pre/code)  file (file-preview.tsx)          tool part (tool-renderers.tsx)   panel block (panel.tsx)
   fenceKind(lang, body)          fileKind(rel) + sniffJson(text)  toolKind(tool) + input             openBlock(input)
             └──────────────────────────┴───────────────┬───────────────────┴─────────────────────────────────┘
                              RichInput { kind, lang, source, title, origin }
 MAIN CHUNK   src/lib/rich/kinds.ts (data) · fence.ts (closure rule) · lazy.ts (useLazy, prefetch) · loaders.ts · actions.ts
              src/components/rich/slot.tsx (FenceSlot, TexSlot, skeletons) · file-loaders.ts (panel kinds, lane C)
                                                        │ useLazy(loadCore)
 RICH CORE    src/components/rich/core.tsx: RichBlock (chat) · RichView (panel) · Tex · RichCollect/RichExport · prerenderForExport
              cache.ts · scheduler.ts · sanitize.ts · shadow-markup.tsx · theme-tokens.ts · toolbar.tsx · lightbox.tsx · repair.ts (2b)
                                                        │ loadRenderer(kind): one literal import() per kind
 RENDERERS    renderers/{mermaid,svg,math,vega,table,markmap}.tsx (lane A) · renderers/{excalidraw,geojson,notebook,preview}.tsx (lane C)
              validate → autofix → [model repair] → toStatic (chat picture, export) | View (panel; chat for tables)
```

- **Two loader maps, one per lane.** `src/lib/rich/loaders.ts` (lane A) holds the chat kinds; `src/components/rich/file-loaders.ts` (lane C) holds panel-only kinds and previews. A kind is **enabled** when either map has a loader for it. Later rounds add kinds without touching the other lane's files.
- **Block actions** ("Edit as drawing", "Try to fix") register through `src/lib/rich/actions.ts`, so lane C adds Round 6's action without editing the core.
- **Every surface renders through the core.** The chat uses `RichBlock`, the panel `RichView`, the HTML export `RichCollect`/`RichExport`.

### 2.3 Lazy loading and prefetch

| Main chunk (≤ 1.5 KB gz for all of it) | Lazy |
|---|---|
| `kinds.ts`, `fence.ts`, `lazy.ts`, `loaders.ts`, `actions.ts`, `slot.tsx`, `file-loaders.ts`; skeleton shapes are CSS in `globals.css` | The rich core (≤ 20 KB gz); `src/lib/rich/math-parse.ts` (≤ 3 KB); each renderer and its CSS (KaTeX, Excalidraw, MapLibre); DOMPurify (shared with Mermaid's copy) |

- **`useLazy(load)`** keeps one module-level record per loader and reads it through `useSyncExternalStore`.
  - Server snapshot and hydration render: `{ module: null, failed: false }`, so a shared chat hydrates without a mismatch.
  - Loading starts in `subscribe`, never during render.
  - A rejected import retries once after 1 s, then reports `failed`; `retry()` drops the rejected promise and imports again.
- **Prefetch signals.** No rich code loads on `/`.

| Signal | Action |
|---|---|
| A text part renders (`TypedText` or `StaticText`) | `prefetchFor(text)` on idle (`requestIdleCallback`, `setTimeout(…, 1)` in Safari): the core and the renderers of the fence languages found, the math chunk if the text has `$`, `\(` or `\[` |
| A rich fence's info line streams in | Import that renderer at once, not on idle |
| Hover or focus of **Open**, **Edit as drawing** or **Run** | Import that chunk |
| A chat route mounts the panel | Idle import of the Preview tab chunk |

### 2.4 The fence lifecycle

**The closure rule** (`fenceState(raw)` in `src/lib/rich/fence.ts`):

1. `raw = source.slice(pre.position.start.offset, pre.position.end.offset)`, where `source` is the exact string given to react-markdown (normalized when the math chunk is loaded).
2. Drop one trailing `\n`. Strip `/^[ \t>]*/` from each line (fences in lists and quotes).
3. The opener's marker is `` ` ``, `~` or `$`; `run` is its length (`$$` counts as 2).
4. **Closed** when there are at least 2 lines and the last line matches `^(marker){run,}[ \t]*$`.
5. **`infoDone`** when `raw` contains a newline. The kind is decided only then.

**`final`** (computed in `parts.tsx`). Written against the `useTypewriter` signature that is committed when 2a starts; the working tree on 2026-10-08 has `useTypewriter(text, live)`. `PartView` passes the whole part, its `streaming` prop and the typewriter's flag (today `open && live`):

```tsx
function TypedText({ part, streaming, live }: { part: TextPart; streaming: boolean; live: boolean }) {
  const typed = useTypewriter(part.text, live)                 // live: watched from its first character (the streaming owner's flag)
  const settled = !streaming || part.time?.end != null         // streaming: MessageView's prop (busy && last assistant message);
                                                               // an aborted turn settles when the session goes idle
  const final = settled && typed.length === part.text.length
  useEffect(() => prefetchFor(part.text), [part.text])
  return <div className="chat-text"><Markdown text={typed} final={final} origin={{ from: "fence", sessionID: part.sessionID, messageID: part.messageID, partID: part.id, endedAt: part.time?.end ?? null }} /></div>
}
// StaticText (read-only), Markdown files in Preview and the legal pages: final defaults to true, no origin.
```

**`FenceSlot` states** (the `pre` override renders `<FenceSlot node={node}>{children}</FenceSlot>`):

| Condition | Renders | `data-rich-state` |
|---|---|---|
| Not a rich kind, kind not enabled, or the info line not done | Today's `CodeBlock` with Copy | none |
| Kind with `chat: "code"` (html, react) | `CodeBlock` plus a **Preview** button (live app with a panel, kind enabled) | none |
| `!closed && !final` | Skeleton of the kind's shape and `minHeight`; caption "Drawing a diagram · 12 lines"; the raw source in a closed `<details>` | `pending` |
| Closed or final; core, renderer or render not done | Live app: the same skeleton with `aria-busy="true"`. Read-only before the core loads: the `CodeBlock` | `loading` |
| Valid | The visual | `ready` |
| Invalid after autofix (and repair, Round 2b), cut off, or too large | `CodeBlock` plus a one-line note (§2.10) | `source` |
| Chunk failed to load, render threw, or 20 s timeout | `CodeBlock` plus a note, **Retry** and (for load failures) **Reload** | `error` |

- **Never `aria-busy` on `pending`.** An open fence in a streaming fixture would hold the harness forever. `loading` is `aria-busy`, so the harness waits for renders by itself.
- **Unclosed but final** (the model forgot the closer, or the turn was cut): `trimPartialCloser` drops a last line of 1–2 backticks, tildes or a lone `$`, then validate. Valid renders; invalid shows "This diagram was cut off." and is never repaired.
- **Too large** (over `KINDS[k].maxBytes`): source plus "Too large to draw here." and **Open** (the panel allows 4×).
- **An error boundary** wraps every block, so a renderer bug never breaks the message.

**Streaming text** is not built here. Round 2a depends on the streaming change (owner: the agent now editing `engine-store.tsx`) being committed, and builds on its API (decision 6). What the rich layer relies on:

- Deltas apply only to parts whose opening (empty) `message.part.updated` arrived over the open stream: a per-page watched set, cleared on reconnect.
- A part joined mid-stream (a reload, a second tab, a chat opened while busy) shows the Writing indicator until its final `message.part.updated`. So `FenceSlot` never sees text that starts in the middle of a reply, and a stream's closing ```` ``` ```` is never read as an opener.
- `message.part.updated` stays authoritative.

**Package 2a.follow** (lane B, after the streaming change is committed) adds only what that commit lacks. Each item is skipped when the committed code already does it:

- **The typewriter** (`src/lib/use-typewriter.ts`): when the new text does not start with the text already shown (a write-back replaced a block), show it all at once instead of retyping the tail.
- **Following late visuals** (`src/components/session-view.tsx`): the owner's `ResizeObserver` follows only while the session is busy. Keep following while `stickToBottom` for 5 s after idle, and whenever a `figure.rich` turns `ready` (rich blocks often finish after idle: chunk load, idle queue). Each kind's `minHeight` sits near its typical picture height, so the jump stays small.
- **`session.deleted`** (`src/lib/engine-store.tsx`): also drops `messages[id]` (today child sessions, such as repair children, leak there).

### 2.5 Math

- **Lazy parser.** `src/lib/rich/math-parse.ts` exports `{ plugins: [remarkMath, remarkMathGuard], normalize }`. `Markdown` reads it through `useLazy` and passes `remarkPlugins = math ? MATH_PLUGINS : BASE_PLUGINS` (module-level arrays, so identity is stable).
- **While the parser loads**, the `.md` root carries `aria-busy="true"` when the text contains a math marker and only while `!module && !failed`, so the harness waits. Prices trigger it too, briefly. On `failed`, the text renders with `BASE_PLUGINS` and the failure goes to `clog`; `aria-busy` never stays.
- **The guard** (Pandoc's rule, from the spike's `math-guard.ts`): the opening `$` is followed by a non-space; the closing `$` follows a non-space and is not followed by a digit. Anything else goes back to text. `$$…$$` is always math.
- **The normalizer** runs on the text before parsing, outside fenced code and inline code: `\(x\)` becomes `$x$` (one line); `\[ … \]` becomes `$$ … $$` (may span lines).
- **Inline math** (`code.language-math.math-inline`) renders `TexSlot`. When the source slice starts with `$$`, it renders inline with `\displaystyle`.
- **Display math** (`pre > code.math-display`) follows the closure rule with marker `$`. Open: the TeX in muted mono, never a KaTeX error. Closed or final: `TexSlot display`.
- **KaTeX options:** `throwOnError: false`, `trust: false`, `strict: "ignore"`, `maxSize: 10`, `maxExpand: 1000`, `output: "htmlAndMathml"` in the app, `output: "mathml"` in the export. KaTeX CSS (`katex/dist/katex.min.css`) is imported inside the math renderer module.
- **Wide display math** scrolls sideways inside `.rich-tex-display` (`overflow-x: auto`).

### 2.6 DOM contract

The harness, the export and screen readers rely on these. Lane A owns them.

| Element | Contract |
|---|---|
| Block | `<figure class="rich" data-rich-kind="<kind>" data-rich-state="pending\|loading\|ready\|source\|error">`, plus `aria-busy="true"` in `loading` only |
| Repaired block | `data-rich-repaired="autofix"` (no caption) or `"model"` (caption **Fixed automatically** inside the toolbar: shown with the toolbar on hover or focus, always on touch, inside the **⋯** sheet below 600 px; decision 8 says "silently", so no banner) |
| Picture | `<div class="rich-clip">` (light DOM: `contain: layout paint; overflow: hidden; position: relative; isolation: isolate; max-height: 600px` in the chat, no `max-height` in the panel) around `<div class="rich-host">`, which holds an open shadow root: svg, mermaid, vega-lite, markmap, notebook HTML outputs. Read-only views render kind `svg` as `<img class="rich-img" src="data:image/svg+xml;base64,…" alt="…">` inside the clip. Tables and interactive views are light DOM |
| Skeleton | `<div class="rich-skel" data-shape="diagram\|chart\|table\|tree" aria-hidden="true">` with an sr-only "Drawing a diagram". Uses `.skel`, which already stops under reduced motion |
| Toolbar | `<div class="rich-bar">`: kind label, caption, **Open**, **Copy**, **Source** (native `<details>`), block actions. Below 600 px: the kind label, **Open** and a **⋯** button that opens a `Sheet` with Copy, Source and the block actions (§2.8) |
| Note | `<p class="rich-note">` (one line, muted, always visible). A `manual` repair puts **Try to fix** in this line, next to "This diagram has a syntax error, so here's its source.", so desktop readers of history see it without hovering |
| Math | `<span class="rich-tex" data-rich-state="loading\|ready">` around KaTeX's `.katex`; display math inside `<div class="rich-tex-display">` |
| Table | `<table aria-rowcount="<rows + 1>">` with `<th scope="col" aria-sort>` holding a sort `<button>` |

**User-facing strings** (fixtures assert some of them):

- "This diagram has a syntax error, so here's its source." (`{noun}` from `KINDS`; the parser's first error line follows in muted mono)
- "This diagram was cut off." · "Too large to draw here." · "Couldn't load the diagram viewer." · "Couldn't draw this diagram."
- "Charts here can't load data from the web." · "This SVG had nothing safe to show."
- "Fixed automatically" · "Try to fix" · "Ask the agent to fix" · "Open table (1,000 rows)"
- "This preview is gone after the reload. Open it again from the chat."

### 2.7 Cache, queue, theme

- **Key:** `${kind}@${renderer.version}|${scheme}|${widthBucket ?? "-"}|${hash(source)}`. `hash` is cyrb53 in base36 plus `:` plus the length; it is cheap enough to run on every typewriter frame.
- **LRU:** 200 entries in the core. A single-flight map shares in-flight renders. On a theme or width change the old picture stays until the new one is ready (never back to a skeleton).
- **Queue:** Mermaid, Vega and Markmap renders run one at a time, each started in `requestIdleCallback` with a 500 ms timeout (`setTimeout` in Safari), with `scheduler.yield()` between items where it exists. Renders time out after 20 s: the block shows its error at once, but the queue slot stays held until the timed-out promise settles (or for another 20 s at most), because a Mermaid render can't be aborted and still holds Mermaid's global state and temporary DOM. Then the queue continues. Blocks render in document order whether or not they are on screen.
- **Theme:** `useResolvedScheme()` in `src/lib/theme.ts` returns `data-theme`, or the media query when there is none, and re-renders on either change. `readTokens()` reads `getComputedStyle(document.documentElement)` at render time; the tokens are hex today.
  - **`LIGHT_TOKENS`** (a const in `theme-tokens.ts`) holds the light values for the export, because `readTokens()` returns the dark values on a dark page and the token rules target `:root`, so no subtree can read light values. A `test:rich` check parses the light `:root` block of `src/app/globals.css` and asserts equality.
  - **Mermaid:** `theme: "base"`, `darkMode: scheme === "dark"`, `fontFamily` = the body's computed font family, and `themeVariables` `primaryColor` = `--surface-2`, `primaryTextColor` = `--ink`, `primaryBorderColor` = `--line-2`, `lineColor` = `--muted`, `secondaryColor` = `--accent-soft`, `tertiaryColor` = `--surface`, `noteBkgColor` = `--accent-soft`, `noteTextColor` = `--ink`, `fontSize` = `14px`.
  - **Vega:** a config with a transparent background, the body font, axis labels and titles in `--ink-2` (`--muted` on the surface is about 3.5:1, below 4.5:1 for small text), domain and ticks in `--line-2`, grid in `--line`, `range.category` = `--ws-0` … `--ws-7`, marks in `--accent`.
  - **Agent SVG** in dark mode sits on a light paper card (`.rich-paper`), so black-on-transparent drawings stay visible.
- **Width buckets** (Vega only): 280, 320, 400, 480, 560, 640, 720 px; the block uses the largest that fits its container (`ResizeObserver`), else 280 scaled down. A 360 px phone's column is about 328 px minus the figure padding, so 280 is the one that fits there.
- **Tall pictures** are capped at 600 px in the chat by `.rich-clip` with a fade and **Open**; the panel shows the natural size.

### 2.8 Phones (390 px; the chat column is about 328–342 px)

- **Pictures** use `max-width: 100%; height: auto` and never widen the column. When the natural width is over 1.6× the column, the caption says "Tap to zoom".
- **Tapping the picture opens the panel layer** (`?panel=preview&block=<key>`); a click does the same on desktop (ROADMAP R2 "zoom on click"). The panel view has **Fit · 100% · 200%**, native scrolling, and Ctrl/⌘+wheel zoom on desktop.
- **Tables** inline on compact screens (< 600 px): 20 rows, sortable, no inner vertical scroller, plus **Open table (N rows)**. Wide tables scroll sideways inside the figure.
- **No iframe ever enters the chat column.** html, jsx and tsx fences stay code with **Preview**.
- **Panel actions that prefill the composer** call `panel.setOpen(false)` first and prefill on the next frame (the chat is `inert` under the layer).
- **Touch:** the toolbar is always visible on coarse pointers with 44 px targets; on fine pointers it reveals on hover and focus (`pointer-fine:opacity-0 group-hover:opacity-100 focus-within:opacity-100`).
- **Toolbar below 600 px:** the kind label, **Open** and a **⋯** button (44 px each) that opens a `Sheet` (`src/components/ui/sheet`) with Copy, Source, the caption and the block actions. Seven 44 px targets would not fit a 328 px column. `chat-rich-fences` asserts `{box: ".chat-log figure.rich .rich-bar", maxWidth: 342, widths: [390]}`.
- **Tests:** every round runs its scenarios with `--browser webkit` too; the harness checks the cloud layout chain for overflow on every run.

### 2.9 Read-only views, shares and the HTML export

**Read-only** means `useReadOnly() != null`: the `/c/[id]` page and the export.

- Every block is final. **Autofix runs; model repair never does.** A failed block shows the source and the note.
- The server HTML shows the code block; after hydration the visual replaces it in one swap.
- **Anyone can make a share hold hostile markup** (have the model echo it), and `/c/[id]` renders on the app's origin for anonymous and signed-in viewers. So kind `svg` renders as an `<img>` data URL here (decision 9), and Mermaid, Vega and Markmap pictures keep the clip and the CSS hooks. `chat-svg-hostile-export` and a manual `/c/<id>` check of the hostile chat cover this path (§3.2a).
- **Open** becomes a native `<dialog>` lightbox around `RichView` (full screen on phones, Esc closes).
- html, jsx and tsx fences stay code with no **Preview**. Live-preview chips show the port as text only.
- `/c/<id>/md` and `.json` keep fences as source. Round 7 adds tool payloads as fences in `/md`.

**The HTML export** (`src/components/share-export.ts`):

1. `await Promise.all([loadCore(), loadMath()])`.
2. **Collect pass:** `flushSync(() => root.render(<RichCollect into={items}><ShareDocument transcript={clipped} /></RichCollect>))`. `FenceSlot` and `TexSlot` push their inputs into `items`, so detection is exactly what a viewer sees. Unmount.
3. **Prerender:** `const statics = await prerenderForExport(items, { timeoutMs: 20_000 })`, always in the light theme: renderers get `LIGHT_TOKENS` (§2.7), never `readTokens()`, so an export made in dark mode still draws light pictures on the light card.
   - mermaid, vega-lite and markmap: `<div class="rich-paper rich-clip"><template shadowrootmode="open">` + `<style>…</style><svg…>` + `</template></div>`. `RichExport` emits the template as `<template shadowrootmode="open" dangerouslySetInnerHTML={{ __html: css + markup }} />`, implemented in `shadow-markup.tsx` (the allowed `innerHTML` site). Children would land in the element, not in `template.content`, and serialize as an empty template (§2.1).
   - svg: `<div class="rich-paper rich-clip"><img src="data:image/svg+xml;base64,…" alt="…"></div>` (decision 9).
   - Math: KaTeX with `output: "mathml"` (no fonts, no CSS).
   - Tables: a static `<table>` of at most 500 rows plus "Showing 500 of N rows".
   - Charts: the SVG plus `<details><summary>Show data</summary><table>…</table></details>` (≤ 500 rows).
4. **Embed pass:** `flushSync(() => root.render(<RichExport statics={statics}><ShareDocument … /></RichExport>))`, then read `innerHTML`. `innerHTML` serializes each template's `.content` (filled by `dangerouslySetInnerHTML`), and the browser that opens the file builds the shadow roots. A `test:rich` check (`scripts/rich-tests/export-dom.ts`, Playwright Chromium on an esbuild bundle, as in the critique's scratch test) asserts that the `innerHTML` of a `RichExport` holding a one-rect SVG contains `<rect`.
5. **`inlineCss()` skips renderer stylesheets:** any sheet that declares a `KaTeX_` font face or contains `.excalidraw` or `.maplibregl-` selectors.
6. Every visual keeps its source under `<details><summary>Source</summary>`. A block missing from `statics` falls back to its code block. The file holds no `<script>`.
7. Declarative shadow DOM needs Chrome 111+, Safari 16.4+ or Firefox 123+, which matches Next 16's floor except Firefox 111–122 (those show the source details).

### 2.10 The repair loop

```
RichBlock: renderer.validate() fails with a repairable RichError (Mermaid parse error; Vega lint, compile or empty)
  1. autofix(source, error) → candidates, each re-validated; the first valid one renders (data-rich-repaired="autofix")
  2. memo (localStorage "syrup.rich.repairs.v1"): a fix renders at once; a failure (< 7 days) skips to step 6
       at most 200 entries (LRU by `at`); every write in try/catch; on QuotaExceeded drop the oldest half and retry once
  3. eligibility: repairEligible(origin, readOnly, now) → "auto" | "manual" | "never"
       never: read-only, no engine, from a file, source > 8 KB, cut off, not repairable
       manual: the reply ended > 10 min ago, or this message already used 3 automatic repairs → "Try to fix" in the note line
  4. capability: GET /agent (cached 10 min per connection) lists "repair"; else treat as "never"
  5. one hidden call, queued one at a time, single-flight across tabs,
     started only while no session in this directory is busy (env.directoryBusy() false; this also covers "first token awaited"):
       POST   /session                 { parentID: sessionID, title: "syrup:repair" }
       POST   /session/{child}/message { agent: "repair", model: { providerID: "syrup", modelID: "fast" },
                                         parts: [{ type: "text", text: repairPrompt(kind, source, error) }] }   (20 s abort; on abort POST /session/{child}/abort)
       DELETE /session/{child}         (finally)
     while in flight, env.directoryBusy() is checked every 100 ms: the user sent a message, so POST /session/{child}/abort,
       DELETE it, and requeue this block as manual ("Try to fix"); the repair's git snapshot must not delay that turn's first token
     extractBlock(reply) → validate → ok: render (data-rich-repaired="model"), memo the fix, schedule the write-back
                                      no: memo the failure, step 6
  6. the source with "This diagram has a syntax error, so here's its source." (manual: plus "Try to fix" in the same note line)
```

**The engine side** (`syrupEngineConfig` in `src/server/engine/opencode.ts`, so local and sandbox match):

```ts
agent: {
  build:  { prompt: SYRUP_PROMPT, permission: { task: { repair: "deny" } } },
  plan:   { prompt: SYRUP_PROMPT, permission: { task: { repair: "deny" } } },
  repair: { mode: "subagent", hidden: true, model: "syrup/fast", prompt: REPAIR_PROMPT, permission: "deny" },
}
```

- `REPAIR_PROMPT` lives in `src/server/engine/repair-prompt.ts` (no conflict with `prompt.ts`): "You fix syntax errors in Mermaid diagrams and Vega-Lite specs. Reply with exactly one fenced code block holding the corrected version and nothing else. Keep the meaning, the labels and the structure; change only what the error needs."
- `AgentPrompts` widens to `{ prompt?; mode?: "primary" | "subagent" | "all"; hidden?: boolean; model?: string; permission?: "allow" | "deny" | Record<string, unknown> }`.
- **Plan's own permissions must survive.** If OpenCode replaces plan's built-in permission object (which denies edits) instead of merging `{ task: { repair: "deny" } }` into it, plan mode would start editing files. A 2b Day-1 check proves the merge (§3.2b). Fallback: drop the task deny from plan only; `repair` then shows in plan's task list, which is harmless.
- `syrupEngineConfig(routerURL, secret, opts?: { promptSuffix?: string })` appends `promptSuffix` to `SYRUP_PROMPT` for build and plan. Callers (`sandbox.ts` in Round 8) pass text through it and never write `agent` themselves, so the repair agent and the task deny can't be dropped.
- **The user message** (`repairPrompt`): ``This {Mermaid diagram | Vega-Lite spec} fails to {parse | compile}:\n{error, ≤ 500 chars}\n\n```{lang}\n{source}\n``` ``.

**The router side** (`src/server/router/policy.ts`, `core.ts`):

- `isRepairCall(messages, tools)`: alias `fast`, no tools, and the first system message starts with `REPAIR_PROMPT`'s first sentence.
- **It reuses Round 1's title path in `core.ts`** (`isTitleCall` → `leashMs` 4 s, one backend, `sessions.detached`, `titleSkipped`). The condition becomes `title || repair`, so the leash code exists once.
- **Additions for repair only:** candidates are filtered to free-tier, non-scarce ones before ranking; `requestedOut` and `max_tokens` are clamped to 2,048 (titles keep 512); router events carry reason `repair`.
- **The body is rewritten before the upstream call:** `messages[0]` becomes `{ role: "system", content: REPAIR_PROMPT }` (OpenCode's system message also carries the env block, the `instructions` with the local MEMORY.md index, and the workspace `AGENTS.md`), and `temperature` is set to `0` (custom models drop it). The user message is kept. `test:router` covers the rewrite.
- No candidate, a failure, or the leash running out: HTTP 400 `{ error: { type: "syrup_repair_skipped", message } }` through a `repairSkipped` twin of `titleSkipped` (the AI SDK never retries a 400). Like titles, a leash expiry is not a health failure.

**"Directory busy"** (`env.directoryBusy()`): any session of this directory in the store is busy or retrying. That includes every turn awaiting its first token. A repair waits for it to clear (polling every 500 ms, at most 60 s, then `busy`), and one in flight is aborted when it turns true (step 5).

**Single flight:** an in-tab map by `kind:hash`; across tabs `navigator.locks.request("syrup.repair." + hash, { ifAvailable: true })`. Not granted: wait up to 15 s for the part to change (the other tab's write-back), else `busy`.

**The write-back** (`writeBack`): wait until the part has `time.end` and the session is idle (give up after 10 minutes and keep the memo). `spliceFence(part.text, original, fixed)` replaces the block body and re-applies each line's list or quote prefix; `null` when the original is no longer there verbatim. Then `PATCH /session/{sid}/message/{mid}/part/{pid}` with the whole part: the new `text`, and `metadata.syrup.repairs` appended with `{ at, kind, original, fixed }`. The PATCH emits `message.part.updated`; the cloud sidecar mirrors it to Postgres, so shares show the fix. A block whose body equals some `repairs[].fixed` renders with `data-rich-repaired="model"`.

**Side effects, handled:**

- The sidecar (`sidecar/events.ts`) remembers session ids created with title `syrup:repair` and drops every event of those sessions, so repairs never reach Postgres. Ids are kept 10 minutes after deletion. It also drops any event whose session info has `title === REPAIR_TITLE`, so a sidecar or engine restart that forgot the ids still filters them.
- **Leftover children are swept.** In the cloud, `AbortOnUnload` (`workspace-view.tsx`) aborts busy children on page hide; locally nothing does, so a tab closed mid-repair leaves an undeleted child. Once per engine connection, the first time the repair module loads, `sweepRepairChildren` lists sessions (`GET /session`) and deletes those with `title === REPAIR_TITLE` whose `time.updated` is over 2 minutes old.
- Child sessions have `parentID`, so the sidebar (`workspaces.tsx`) and cloud history hide them.
- Repair tokens stay in the ledger and `router_events`: spend remains visible.

**Telemetry:** PostHog `rich_repair { kind, via: "autofix" | "model" | "none", ok, ms }`, only when `posthog.__loaded`.

### 2.11 Error UI and logging

| Failure | What the user sees | Recovery |
|---|---|---|
| Renderer chunk fails (offline; a deploy renamed chunks) | Code block plus "Couldn't load the diagram viewer." | One automatic retry after 1 s; **Retry** re-imports; **Reload** |
| Render throws or exceeds 20 s | Code block plus "Couldn't draw this diagram." | **Retry** |
| Theme switch mid-render | The old picture until the new one is ready | Cache keyed by theme |
| Event stream reconnects | Nothing changes; renders come from the cache | — |
| Invalid input | §2.10 | — |

- **Expected failures never `console.error`.** They go to the client log (`clog`, which posts to `/api/logs`): the harness fails on console errors, and a user's syntax error is not a bug. Mermaid runs with `logLevel: "fatal"`; Vega with a capturing logger.
- **PostHog:** `rich_block_render { kind, ms, ok, repaired }` and `rich_block_error { kind, code }`, never content, only when `posthog.__loaded` (opt-out respected).

### 2.12 Security model

| Surface | Mechanism |
|---|---|
| Agent SVG (fences, `.svg` files, notebook SVG outputs) | **Our own** `createDOMPurify(window)` instance, never Mermaid's. `USE_PROFILES: { svg: true, svgFilters: true }`; `FORBID_TAGS: ["foreignObject", "script", "animate", "set", "animateMotion", "animateTransform"]`. **URL hooks:** drop `href`, `xlink:href` and `src` unless they start with `#` (an `<image>` may also use `data:image/(png\|jpeg\|gif\|webp)`); drop `attributeName` values naming `href`, `xlink:href` or `on*`. **CSS hooks**, on every `<style>` element and every `style` attribute: allow `url(` only as `url(#…)`; refuse any quoted string containing `:` or `//`; refuse `image-set(`, `-webkit-image-set(`, `@import` and `@font-face` outright (`image-set("https://…" 1x)` fetches without `url(`). A refused `style` attribute is dropped; a refused `<style>` is emptied. In `<style>`, rules whose selector contains `:host` are dropped, and in both places `position: fixed` and `position: sticky` declarations are dropped. Inputs over 200 KB are refused before parsing. Mounted in an open shadow root with `:host{display:block} svg{max-width:100%;height:auto}`, inside the light-DOM `.rich-clip` (§2.6), which confines anything that still escapes the box. Read-only views use an `<img>` data URL instead (decision 9) |
| Mermaid | `startOnLoad: false`, `securityLevel: "strict"`, `suppressErrorRendering: true`, `logLevel: "fatal"`, `maxTextSize: 80_000`, `maxEdges: 500`; the chat refuses sources over 20 KB. `secure` = Mermaid's defaults (`secure`, `securityLevel`, `startOnLoad`, `maxTextSize`, `suppressErrorRendering`, `maxEdges`) plus `dompurifyConfig`, `themeCSS`, `themeVariables`, `theme`, `darkMode`, `fontFamily`, `htmlLabels`, `look`, `layout`, so an `%%{init}%%` directive can't loosen anything. The output gets an outer pass by our instance with the SVG and HTML profiles (foreignObject allowed for labels) and the agent-SVG URL and CSS hooks (a `style A position:fixed` or `classDef` lands in a `style` attribute or the diagram's `<style>`), then a shadow root inside `.rich-clip`. Every call into the singleton, the Excalidraw converter's included, goes through `runWithMermaid` (§3.2a) |
| KaTeX | `trust: false`, `maxExpand: 1000`, `maxSize: 10`, `strict: "ignore"` |
| Vega-Lite | `parse(spec, config, { ast: true })` with `vega-interpreter` (no `Function()`); the loader's `sanitize` throws for every URI (data, images, links); `href` encodings and URL `image` marks fail the lint; `toSVG()` output goes through the agent-SVG sanitizer |
| Markmap | The tree builder HTML-escapes every label (markmap renders labels as HTML in `<foreignObject>`); only `<strong>`, `<em>` and `<code>` wrap escaped text. Its static markup therefore skips the agent-SVG sanitizer (which forbids `foreignObject` and would drop every label); it is mounted in a shadow root inside `.rich-clip` like every picture |
| Tables | Text cells only. **Copy CSV** prefixes `'` to cells starting with `=`, `+`, `-`, `@`, tab or CR (OWASP formula injection). **Copy source** stays verbatim |
| Notebook HTML outputs | DOMPurify HTML profile; tags `style`, `script`, `iframe`, `form`, `object`, `embed` forbidden; `FORBID_ATTR: ["style", "srcset"]`; the agent-SVG URL hooks, except that `src` is kept for `data:image/(png\|jpeg\|gif\|webp)` only and a link's `href` for `https:` (or `#`) only, with `target="_blank" rel="noopener noreferrer"` added. Real notebooks (pandas Styler, plotly fallbacks) carry remote images and inline styles, which would otherwise load third-party content from the app's origin or overlay the page. In a shadow root inside `.rich-clip` |
| Excalidraw | `restore()` normalizes the scene; `scrubScene` drops embeddables and iframe elements, links that aren't https, and images that aren't `data:image/*`, on load and again before save; `validateEmbeddable={() => false}`; links open https only with `noopener,noreferrer` |
| One mount point | `shadow-markup.tsx` (live shadow roots, the export's `<template shadowrootmode>` via `dangerouslySetInnerHTML`, and the read-only `<img>` data URL) and the math renderer are the only `innerHTML`/`dangerouslySetInnerHTML` sites under `src/components/rich/`; `test:rich` greps for others and fails |
| Local API and pages | Round G guard (§3.G): loopback Host on every path, Origin and Sec-Fetch-Site on `/api` |
| HTML/React previews | Separate site, opaque-origin sandbox, egress CSP (images and fetches: esm.sh only), nonce protocol (§3.5) |
| Live previews | Public capability URLs in the cloud: never persisted, logged in full, sent to analytics or shared; closed when unused; rotated at each engine start. Locally syrup's own ports can't be framed (§3.8) |

### 2.13 Accessibility

- **Figures:** the host has `role="img"` and an `aria-label` built from the kind, the title and the first labels ("Flowchart, 10 steps: Customer opens the cart, Cart empty?…"); the inner SVG is `aria-hidden` (the read-only `<img>` carries the same text as `alt`). **Source** is a native `<details>`.
- **Charts:** "Show data" in the panel opens the inline values as a real table.
- **Math:** `htmlAndMathml` in the app, so screen readers read the MathML.
- **Tables:** `<th scope="col">` with a sort `<button>` and `aria-sort`; `aria-rowcount` and `aria-rowindex` on virtualized rows; a caption with the row and column count.
- **Panel:** opening a block moves focus into the panel; Esc closes it (existing). Preview iframes have a `title`; the console strip is `role="log"`.
- **Forms (Round 7):** every field has a `<label>`; required fields say "required" in text; errors use `aria-invalid` plus `aria-describedby`; native input types bring the right phone keyboard.
- **Motion:** skeletons use `.skel` (stops under reduced motion); Markmap transitions use `duration: 0` under reduced motion; nothing else animates.

### 2.14 Local and cloud: what differs

Only these backend calls differ; the UI is the same.

| Need | Local | Cloud | Client API |
|---|---|---|---|
| Read a file | `/api/workspace/files?op=raw` | engine `file.read` (text trimmed); `op=raw` up to 4 MB for exact bytes | `read()`; `readExact()` (Round 6) |
| Write a file (Round 6) | `op=write`, local route | `op=write`, cloud route (sandbox SDK) | `writeFile()` |
| Repair and PATCH | `/api/oc` proxy | the sandbox engine directly (Basic auth) | `oc(directory, connection)` |
| Preview origin (Round 5) | `http://127.0.0.1:4211` (in-process listener) | `https://syrup-preview.vercel.app` | `previewOrigin(remote)` |
| Structured tools (Round 7) | MCP server on the router port | MCP server in the sidecar | the same `buildMemoryServer` |
| Live preview (Round 8) | `http://localhost:<port>/` | `https://sb-….vercel.run` from `POST /api/workspaces/[id]/preview` | `openLive(port)` |

### 2.15 Shared interfaces

```ts
// src/lib/rich/kinds.ts — main chunk, data only, no imports (lane A, Round 2a; lists every kind from the start)
export type RichKind = "mermaid" | "svg" | "vega-lite" | "table" | "markmap" | "excalidraw" | "geojson" | "notebook" | "html" | "react"
export type SkeletonShape = "diagram" | "chart" | "table" | "tree"
export interface KindInfo {
  noun: string                               // "diagram" → notes and the "Preview · Diagram" tab label
  skeleton: SkeletonShape
  minHeight: number                          // px reserved while pending or loading; near the kind's typical picture height, so late renders jump little
  chat: "static" | "interactive" | "code" | "none"
  repairable: boolean
  maxBytes: number                           // chat cap; the panel allows 4×
}
export const KINDS: Readonly<Record<RichKind, KindInfo>>
export function fenceKind(lang: string, body?: string): RichKind | null   // body only once closed or final
export function fileKind(rel: string): RichKind | null                    // full-name suffixes first, then the extension
export function toolKind(tool: string): RichKind | "form" | null          // Round 7 ids

// src/lib/rich/fence.ts — main chunk, pure
export interface FenceState { marker: "`" | "~" | "$"; run: number; infoDone: boolean; closed: boolean }
export function fenceState(raw: string): FenceState
export function trimPartialCloser(body: string, marker: FenceState["marker"]): string
export function hash(s: string): string                                    // cyrb53 base36 + ":" + length

// src/lib/rich/lazy.ts — main chunk
export type Lazy<T> = { module: T | null; failed: boolean; retry(): void }
export function useLazy<T>(load: () => Promise<T>): Lazy<T>
export function loadCore(): Promise<typeof import("@/components/rich/core")>
export function loadMath(): Promise<typeof import("@/lib/rich/math-parse")>
export function prefetchFor(text: string): void

// src/lib/rich/loaders.ts (lane A) and src/components/rich/file-loaders.ts (lane C) — main chunk
export type RendererModule = { default: Renderer }
export const CHAT_RENDERERS: Partial<Record<RichKind, () => Promise<RendererModule>>>   // loaders.ts
export const FILE_RENDERERS: Partial<Record<RichKind, () => Promise<RendererModule>>>   // file-loaders.ts
export function loadRenderer(kind: RichKind): (() => Promise<RendererModule>) | null     // loaders.ts: chat map, then file map
export function enabled(kind: RichKind): boolean

// src/lib/rich/actions.ts — main chunk
export interface ActionEnv { readOnly: boolean; engine: { directory: string; connection: Connection | null } | null; panel: { openFile(path: string): void; openBlock(input: RichInput): void } | null }
export interface BlockAction { id: string; label: string; kinds: RichKind[]; when(i: RichInput, env: ActionEnv): boolean; run(i: RichInput, env: ActionEnv): Promise<void>; prefetch?(): void }
export function registerBlockAction(a: BlockAction): void
export function blockActions(i: RichInput, env: ActionEnv): BlockAction[]

// src/components/rich/types.ts — types only
export type RichOrigin =
  | { from: "fence"; sessionID: string | null; messageID: string | null; partID: string | null; endedAt: number | null }
  | { from: "file"; rel: string }
  | { from: "tool"; sessionID: string; messageID: string; partID: string; tool: string }
  | { from: "block" }
export interface RichInput { kind: RichKind; lang: string; source: string; title?: string; origin: RichOrigin }
export type RichSurface = "chat" | "panel" | "export"
export type RichState = "pending" | "loading" | "ready" | "source" | "error"
export interface RichError { code: "parse" | "schema" | "empty" | "remote" | "cut-off" | "too-large" | "render" | "timeout" | "load"; message: string; line?: number; repairable: boolean }
export type Validated<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: RichError }
export interface ThemeTokens { scheme: "light" | "dark"; font: string; mono: string; ink: string; ink2: string; muted: string; line: string; line2: string; surface: string; surface2: string; accent: string; accentSoft: string; ok: string; warn: string; err: string; series: string[] }
export interface RenderCtx { surface: RichSurface; tokens: ThemeTokens; width: number; signal: AbortSignal }
export interface StaticRender { markup: string; css?: string; width: number; height: number; label: string }
export interface Renderer<T = unknown> {
  kind: RichKind
  version: string                                                       // "mermaid@11.17.2/r1": part of every cache key
  validate(input: RichInput, signal: AbortSignal): Promise<Validated<T>>
  autofix?(source: string, error: RichError): string[]                  // deterministic candidates; the first valid one wins
  toStatic?(value: T, ctx: RenderCtx): Promise<StaticRender>             // the chat picture (static kinds) and the export (all kinds)
  View?: ComponentType<{ value: T; input: RichInput; ctx: RenderCtx }>  // the panel; the chat too for "interactive" kinds
}
export type ExportItems = { blocks: RichInput[]; tex: { tex: string; display: boolean }[] }

// src/components/rich/core.tsx — the lazy rich core
export function RichBlock(p: { input: RichInput; final: boolean; readOnly: boolean }): JSX.Element
export function RichView(p: { input: RichInput }): JSX.Element
export function Tex(p: { tex: string; display: boolean }): JSX.Element
export function RichCollect(p: { into: ExportItems; children: ReactNode }): JSX.Element
export function RichExport(p: { statics: Map<string, StaticRender | null>; children: ReactNode }): JSX.Element   // templates via dangerouslySetInnerHTML (§2.9)
export function prerenderForExport(items: ExportItems, o: { timeoutMs: number }): Promise<Map<string, StaticRender | null>>   // tokens: LIGHT_TOKENS

// src/components/rich/theme-tokens.ts — in the core chunk
export function readTokens(scheme: "light" | "dark"): ThemeTokens       // computed :root values of the current page
export const LIGHT_TOKENS: Readonly<ThemeTokens>                        // the light :root values; test:rich checks them against globals.css

// src/lib/panel.tsx — additions (Round 2a; live blocks in Round 8)
export type PanelBlock = { key: string; input: RichInput } | { key: string; live: { port: number } }
// Ctx gains: block: PanelBlock | null; openBlock(input: RichInput): void; openLive(port: number): void (Round 8); closeBlock(): void
// openBlock: key = hash(kind + source); the block lives in a module Map; phones push ?panel=preview&block=<key>; openFile() clears it
export function prefillComposer(text: string, opts?: { mode?: "replace" | "append" }): void   // mode from Round 6; default replace
```

---

## 3. Rounds

### 3.0 For every round

**The gate** (TESTING.md §1, extended as rounds land). Each command must exit 0.

```bash
pnpm typecheck
pnpm exec eslint src scripts sidecar
pnpm test:router
pnpm test:diffs
pnpm test:transcript
pnpm test:guard                                   # from Round G
pnpm test:rich                                    # from Round 2a
pnpm test:preview                                 # from Round 5
pnpm test:files                                   # from Round 6
pnpm test:show                                    # from Round 7
pnpm ui:harness --label round-N
pnpm ui:harness --browser webkit --label round-N-webkit --only <the round's scenarios>
pnpm ui:weight --compare                          # Round G on
pnpm ui:weight --compare --budgets                # from Round 2a (W1)
pnpm ui:weight --compare --budgets --perf         # from Round 3 (W2); replaces the line above
```

- **Where it runs** (decision 30): typecheck, ESLint and the node suites anywhere; the two `ui:harness` lines and `ui:weight` only in the main checkout, and only when `git status --short` lists no file outside the round. If foreign edits are present, ask their owners to commit first.
- **Look at every screenshot** of the screens the round touched, at both widths.
- **`pnpm bench:agent` before and after** in Rounds 2b (router change) and 7 (tool schemas). `bench:agent` drives the running dev server, and the new router code, repair agent and MCP tools load only after a restart. So: bench "before" on the running server before the round's branches are merged (HMR would otherwise mix in some new code); the founder restarts `pnpm dev` after the gate passes (§6 I4); bench "after"; paste both tables into the commit message. A slower median first token on the opening turn blocks the push until explained.
- **Initial JS** may grow at most 2 KB gz per round and no chunk may join the initial load (`--compare`). Round 2a's target is ≤ 0 (decision 4). So that the budget is per round, not shared across rounds, the integrator runs `pnpm ui:weight --update` before each round's commit, commits the new baseline with it, and records the before and after gzip figures in the commit message (§4.4 step 7).
- **Prompt cost:** `# What the chat can show` stays under about 250 tokens in total (it rides on every request). `scripts/rich-tests/prompt.ts` (2a.integrate) estimates the section's tokens from `SYRUP_PROMPT` (characters ÷ 4) and fails above 250. Every round that edits the prompt records the token delta in its commit message.

**How `pnpm test:rich` is laid out**, so every package owns its own test file:

- `scripts/test-rich.mjs` (package 2a.core) is only a runner. It bundles each `scripts/rich-tests/*.ts` with esbuild (like `test-transcript.mjs`), runs them in name order, and exits 1 on any failed check.
- Each test file exports `default function (check: (ok: boolean, label: string, detail?: string) => void): void | Promise<void>`. It imports the modules under test by path or the `@/` alias (the runner passes `tsconfig.json` to esbuild). `tsconfig.json` includes `**/*.ts`, so `pnpm typecheck` checks these files too.
- A package adds tests by adding a file there; no package edits the runner after 2a. Owners: `fence.ts`, `math.ts`, `autofix.ts`, `cache.ts`, `grep.ts`, `tokens.ts`, `export-dom.ts` (2a.core); `prompt.ts` (2a.integrate); `repair.ts` (2b.client); `vega.ts`, `csv.ts`, `markmap.ts` (3.renderers); `files.ts` (4.files); `scene-diff.ts` (6.editor); `ports.ts` (8.ui).
- `export-dom.ts` is the one browser test: it bundles `RichExport` with esbuild and runs it in Playwright's Chromium (already installed for the harness), no dev server needed.

**After-load budgets** (`scripts/fixtures/js-budgets.json`, gzip JS + CSS, the libraries spike's measurements plus about 10%):

| Chunk | Budget | Scenario that measures it |
|---|---|---|
| Rich core | 20 KB | `weight-svg` (core + SVG) |
| Math parser | 3 KB | `weight-math` |
| KaTeX (JS + CSS) | 85 KB; fonts ≤ 60 KB | `weight-math` |
| SVG (DOMPurify) | 15 KB; 0 once Mermaid has loaded | `weight-svg` |
| Mermaid, common diagrams | 230 KB | `weight-mermaid` |
| Mermaid, pie, gitGraph, architecture, mindmap | 360 KB | not gated |
| Vega + Vega-Lite + interpreter | 295 KB | `weight-vega` |
| Table | 25 KB | `weight-table` |
| Markmap | 35 KB | `weight-markmap` |
| Excalidraw | 400 KB + 22 KB CSS | `weight-excalidraw` (panel) |
| MapLibre | 450 KB | `weight-geojson` (panel) |
| Notebook extras | 10 KB | `weight-notebook` (panel) |
| Mermaid → Excalidraw converter | 25 KB | not gated (on click) |
| Preview frame | 10 KB | `weight-preview` (panel) |

**Dependencies, installed once in package 2a.deps** (exact pins; the libraries spike validated them with pnpm 11.17, Next 16.3.5 Turbopack, strict `tsc` and syrup's ESLint):

```bash
pnpm add --save-exact mermaid@11.17.2 katex@0.19.0 remark-math@6.0.0 dompurify@3.4.16 \
  vega@6.4.0 vega-lite@6.4.3 vega-interpreter@2.3.2 @tanstack/react-table@9.2.6 @tanstack/react-virtual@3.14.13 \
  markmap-view@0.18.12 markmap-common@0.18.9 mdast-util-from-markdown@2.0.3 \
  @excalidraw/excalidraw@0.18.1 @excalidraw/mermaid-to-excalidraw@2.2.2 maplibre-gl@6.13.0 anser@2.3.5
pnpm add --save-exact -D @types/mdast@4.0.4
```

- **maplibre-gl 6.13.0** was published 2026-10-06 19:55 UTC; pnpm 11's one-day `minimumReleaseAge` admits it from 2026-10-07 19:55 UTC. If pnpm writes a `minimumReleaseAgeExclude` entry into `pnpm-workspace.yaml`, revert that edit and pin `6.12.0`.
- **Check after install:** `pnpm why dompurify`, `pnpm why mermaid` and `pnpm why vega-util` each show one version (Mermaid wants `^3.3.3` of DOMPurify; the converter wants `^11.12.1` of Mermaid; `vega-interpreter@2.3.2` has no peer dependencies and wants `vega-util ^2.1.3`, which `vega@6.4.0`'s `~2.1.3` satisfies, checked on npm 2026-10-08).
- **The same package adds the script** `"test:rich": "node scripts/test-rich.mjs"` to `package.json`, so no other Round 2a package edits that file. Until 2a.core lands the runner, the script is not run.
- **Which round uses what:** 2a mermaid, katex, remark-math, dompurify · 3 vega, vega-lite, vega-interpreter, both TanStack packages, markmap-view, markmap-common, mdast-util-from-markdown, @types/mdast · 4 @excalidraw/excalidraw, maplibre-gl, anser · 6 @excalidraw/mermaid-to-excalidraw · G, 2b, 5, 7, 8 nothing new (Round 5's libraries load from esm.sh inside the preview origin; Round 7 uses the zod and MCP SDK already installed). Packages installed before their round are simply unused until then; the gate doesn't mind.
- **Not installed:** `vega-embed`, ajv and the Vega-Lite schema, `markmap-lib`, `@mermaid-js/parser`, `@probelabs/maid`, `rehype-katex`, `@excalidraw/utils`, any notebook library, DOMPurify types (it ships its own), sucrase (loaded from esm.sh inside the preview origin only).
- **Preview allow-list** (pinned in `preview-shell/index.html`, npm latest on 2026-10-07): `react@19.2.8`, `react-dom@19.2.8` (the app's version), `recharts@3.10.1`, `lucide-react@1.52.0`, `d3@7.9.0`, `three@0.186.1`, `papaparse@5.7.0`, `mathjs@15.2.0`, `lodash-es@4.18.1` (also mapped as `lodash`), `sucrase@3.35.1`.

**The prompt section.** Round 2a adds `# What the chat can show` to `src/server/engine/prompt.ts`, right after `# How you talk`. Each later round appends its bullets there. Prompt edits reach the local engine after a `pnpm dev` restart and a sandbox at its next engine start.

**Docs per round** (the round's integrate package): the ROADMAP status row and the §8 corrections for that round; TESTING.md (scenarios, commands); ARCHITECTURE.md gets a short "Rich output" section in Round 2a and a line per later round.

---

### 3.G Round G: local origin guard (½ day, ships first, once the redaction change in `route.ts` is committed)

**Scope**

- **Every local request the proxy matcher covers**, pages included: the Host must be loopback. Today this runs for `/api/*` only, so a DNS-rebinding page can read server-rendered transcripts at `/c/<id>`, `/c/<id>/md` and `/c/<id>/json` (it needs the id). In local mode the guard runs before `shareVariant`, which today rewrites `/c/<id>.md` and `.json` ahead of any guard.
- **Every local `/api/*` request**, GET included, also:
  - `Sec-Fetch-Site`, when present, must be `same-origin` or `none`.
  - `Origin`, when present, must equal `http://` + the Host header, port included (`null` is refused).
- Clients without those headers (curl, scripts, server code) still pass. Pages keep working from any link (no Sec-Fetch-Site or Origin rule outside `/api`). Cloud mode is unchanged.
- `/api/oc/[...path]` stops forwarding `origin`, `referer` and `cookie` to OpenCode, and deletes `access-control-*` from upstream responses.
- **Waits for the redaction change.** `src/app/api/oc/[...path]/route.ts` holds another agent's uncommitted secret redaction (`REDACT`, `scrub`, `scrubProvider` for `config/providers`, `provider`, `config`, `global/config` and `agent`). Round G starts on that file only after it is committed, and changes exactly two things there:
  1. The request-header loop (`new Headers()`, `req.headers.forEach(…)`, then `headers.set("authorization", engineAuthHeader())`) becomes `const headers = proxyRequestHeaders(req.headers, engineAuthHeader())`.
  2. `new Headers(upstream.headers)` becomes `proxyResponseHeaders(upstream.headers)`. Both response branches (the redacted JSON one and the streamed one) already use that one `out` object, so both lose `access-control-*`.

**Files**

| Change | File |
|---|---|
| add | `src/server/local-guard.ts`, `scripts/test-guard.mjs` |
| change | `src/proxy.ts` (`localGuard` calls `localGuardDecision` for every matched path in local mode), `src/app/api/oc/[...path]/route.ts` (the two header helpers only, as above), `package.json` (script `"test:guard": "node scripts/test-guard.mjs"`) |

**Dependencies:** no packages. **Depends on:** the redaction change in `route.ts` committed by its owner.

**Interfaces**

```ts
// src/server/local-guard.ts — pure
export type GuardInput = { method: string; pathname: string; host: string | null; origin: string | null; secFetchSite: string | null }   // Host rule on every path; Origin and Sec-Fetch-Site rules on /api/* only
export type GuardDecision = { ok: true } | { ok: false; status: 403; error: string }
export function localGuardDecision(r: GuardInput): GuardDecision
export function proxyRequestHeaders(incoming: Headers, engineAuth: string): Headers   // today's hop-by-hop and authorization rules, minus origin, referer, cookie
export function proxyResponseHeaders(upstream: Headers): Headers                     // today's rules, minus access-control-*
```

**Security:** closes the live-verified read of every chat by any loopback page (for example an agent's Vite app on :5173). Prerequisite for Rounds 5 and 8 locally.

**Acceptance**

- **`pnpm test:guard`** (esbuild bundle, like `test-diffs.mjs`):

| # | Method | Host | Origin | Sec-Fetch-Site | Expect |
|---|---|---|---|---|---|
| 1 | GET | `127.0.0.1:3000` | — | — | ok |
| 2 | GET | `127.0.0.1:3000` | `http://127.0.0.1:3000` | `same-origin` | ok |
| 3 | GET | `localhost:3000` | `http://localhost:3000` | `same-origin` | ok |
| 4 | GET | `127.0.0.1:3000` | — | `none` | ok |
| 5 | GET | `127.0.0.1:3000` | `http://localhost:5173` | `same-site` | 403 |
| 6 | GET | `127.0.0.1:3000` | `http://127.0.0.1:4211` | `same-site` | 403 |
| 7 | GET | `127.0.0.1:3000` | — | `cross-site` | 403 |
| 8 | POST | `127.0.0.1:3000` | `null` | `cross-site` | 403 |
| 9 | POST | `127.0.0.1:3000` | `http://127.0.0.1:5173` | — | 403 |
| 10 | GET | `evil.test` | — | — | 403 |
| 11 | GET | `[::1]:3000` | `http://[::1]:3000` | `same-origin` | ok |
| 12 | GET | `127.0.0.1:3000` | `https://127.0.0.1:3000` | `same-origin` | 403 |
| 13 | GET `/c/x` | `evil.test` | — | — | 403 |
| 14 | GET `/c/x` | `127.0.0.1:3000` | — | `cross-site` | ok (pages have no Sec-Fetch-Site rule) |
| 15 | GET `/c/x` | `127.0.0.1:3000` | — | — | ok |

  Rows 1–12 use path `/api/oc/session`.
  Plus: `proxyRequestHeaders` drops `origin`, `referer`, `cookie` and the client's `authorization`; `proxyResponseHeaders` drops `access-control-allow-origin` and keeps `content-type`.
  Plus, through the route itself: `test-guard.mjs` bundles `route.ts`'s `GET` with esbuild, its server imports stubbed by an esbuild plugin, and a fake `fetch` answering `config` with JSON and `access-control-allow-origin: *`. The response goes through `REDACT` and still has no `access-control-allow-origin`. If stubbing the route's imports proves heavier than half an hour, the same check runs live instead: `curl -s -D - -o /dev/null http://127.0.0.1:3000/api/oc/config` shows no `access-control-` header.
- **Live** (dev server, HMR picks it up): `curl -s -o /dev/null -w "%{http_code}" -H "Origin: http://localhost:5173" http://127.0.0.1:3000/api/oc/session` prints 403; the same without the header prints 200; `curl -s -o /dev/null -w "%{http_code}" -H "Host: evil.test" http://127.0.0.1:3000/c/x` prints 403.
- **Harness:** every existing scenario passes (the harness answers `/api` in the browser, so it is unaffected).
- **Weight:** `pnpm ui:weight --compare` only (`--budgets` does not exist until Round 2a); unchanged (server code only).

**Done when:** the gate passes, the three live curl checks hold, the app works locally, pushed and deployed.

---

### 3.2a Round 2a: Mermaid, SVG, math, the export (about 2 days, once the streaming change is committed)

**Scope**

- Builds on the streaming change (owner: the agent now editing `engine-store.tsx`), which must be committed first (decision 6). Package 2a.follow adds only what that commit lacks (§2.4).
- Closed ```` ```mermaid ```` fences become diagrams, ```` ```svg ```` sanitized inline SVG, `$…$`, `$$…$$`, `\(…\)` and `\[…\]` KaTeX.
- A kind-shaped skeleton while a fence is open; the deterministic Mermaid autofix; the source and a note when a diagram stays broken (model repair is Round 2b).
- Click or tap a picture to open it in the panel at full size.
- `/c/[id]` and the HTML export show the visuals.
- The Preview tab leaves the initial bundle (decision 4). Its loading fallback is the panel's existing loader (`role="status"` with an `aria-label`), which the harness already waits for, and it is imported on idle once a chat route mounts the Workbench.
- `vega-lite`, `csv`, `json` and `markmap` fences stay code blocks until Round 3.

**Files** (by package; §4.3)

| Package | Add | Change |
|---|---|---|
| 2a.deps | — | `package.json` (dependencies, script `test:rich`), `pnpm-lock.yaml` |
| 2a.follow | — | `src/lib/use-typewriter.ts`, `src/components/session-view.tsx`, `src/lib/engine-store.tsx` (`session.deleted` case only); each item only if the committed streaming change lacks it (§2.4) |
| 2a.core | `src/lib/rich/{kinds,fence,lazy,loaders,actions,math-parse,autofix}.ts`, `src/components/rich/{types,cache,scheduler,sanitize,theme-tokens}.ts`, `src/components/rich/{slot,core,shadow-markup,toolbar,lightbox}.tsx`, `src/components/rich/renderers/{mermaid,svg,math}.tsx`, `scripts/test-rich.mjs`, `scripts/rich-tests/{fence,math,autofix,cache,grep,tokens,export-dom}.ts` | `src/components/markdown.tsx`, `src/components/parts.tsx` (`TypedText`, `StaticText` and the `TypedText` call in `PartView` only), `src/lib/theme.ts` (`useResolvedScheme`), `src/app/globals.css` (`.rich*`, `.rich-clip`, skeleton shapes, `.rich-tex-display`) |
| 2a.panel | `src/components/rich/block-preview.tsx`, `src/components/rich/file-loaders.ts` (an empty map for now) | `src/lib/panel.tsx` (block state), `src/components/side-panel.tsx` (lazy `FilePreview`, `BlockPreview`, tab label), `src/components/share-export.ts` (collect → prerender → embed, stylesheet skip list) |
| 2a.harness | `scripts/fixtures/js-budgets.json` | `scripts/ui-harness.mjs`, `scripts/fixtures/ui/_kit.mjs`, `scripts/js-weight.mjs`, `docs/TESTING.md` (H1, H3, H4, H10, W1; §5) |
| 2a.integrate | `scripts/fixtures/ui/{chat-rich-streaming,chat-rich-broken,chat-svg-hostile,chat-rich-zoom,chat-rich-export,weight-mermaid,weight-math,weight-svg}.mjs`, `scripts/rich-tests/prompt.ts` | `src/server/engine/prompt.ts`, `scripts/fixtures/ui/{chat-rich-fences,chat-streaming}.mjs` (`chat-streaming`: one added assertion, below), `scripts/fixtures/js-weight-baseline.json` (re-baselined, §3.2a Weight), `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` |

Every 2a package except 2a.deps waits for the streaming change to be committed: `parts.tsx`, `side-panel.tsx`, `ui-harness.mjs`, `_kit.mjs`, `chat-streaming.mjs` and the 2a.follow files are part of it today. Lane A may write its new files (`kinds.ts`, `types.ts`, …) before then.

**Dependencies:** `mermaid@11.17.2`, `katex@0.19.0`, `remark-math@6.0.0`, `dompurify@3.4.16`, installed with the whole set by 2a.deps (§3.0).

**Key interfaces** (beyond §2.15)

```ts
// src/components/markdown.tsx
export const Markdown: (p: { text: string; final?: boolean; origin?: Extract<RichOrigin, { from: "fence" }> }) => JSX.Element

// src/lib/rich/math-parse.ts — lazy
export const plugins: PluggableList                    // [remarkMath, remarkMathGuard]
export function normalize(text: string): string        // \(…\) → $…$, \[…\] → $$…$$, outside code

// src/lib/rich/autofix.ts — pure (Mermaid now; Vega in Round 3)
export function mermaidFixes(source: string): string[] // ≤ 5 candidates: quote labels holding ()[]{}| inside shape brackets; replace smart quotes;
                                                       // drop stray fence lines; `;` and missing `:` in sequence messages; `->` in state diagrams; missing `:` in pie

// src/components/rich/renderers/mermaid.tsx — lazy; the only door to the Mermaid singleton
export function mermaidConfig(tokens: ThemeTokens): MermaidConfig       // theme "base", themeVariables, securityLevel "strict", logLevel "fatal", …
export function runWithMermaid<T>(fn: (mermaid: Mermaid, config: MermaidConfig) => Promise<T>): Promise<T>
// runs fn in the render queue (one at a time); afterwards marks "initialized for scheme" dirty, so the next render calls initialize again
```

**Renderer specifics**

- **`renderers/mermaid.tsx`:** `initialize` once per theme change through the render queue (`initialize` is global), and again after any `runWithMermaid` call (a foreign `initialize` may have changed the config). `validate` calls `mermaid.parse(source)` (its message feeds repair). `toStatic` calls `mermaid.render("rich-" + hash, source)`, runs the outer DOMPurify pass with the CSS hooks, and returns the SVG string. Version `mermaid@11.17.2/r1`.
- **`renderers/svg.tsx`:** `validate` sanitizes (§2.12); an empty result is `RichError` "This SVG had nothing safe to show." (not repairable). `toStatic` returns the clean SVG; the paper card applies in dark mode. Width from the SVG's `width` or viewBox, capped at 100%. In read-only views the core mounts it as an `<img>` data URL (decision 9).
- **`renderers/math.tsx`:** `katex.renderToString` with §2.5's options; a per-formula `Map` cache. Imports `katex/dist/katex.min.css`.
- **Panel view** (`RichView` for mermaid and svg): natural size, scrolling, **Fit · 100% · 200%**, Copy.

**Behaviour**

- **Streaming:** skeleton while open; when the typewriter passes the closer, the skeleton becomes the visual in one step. Inline `$…$` renders as soon as its closing `$` is typed.
- **Read-only:** §2.9. **Phones:** §2.8. **Local and cloud:** identical; nothing server-side.

**Prompt** (`# What the chat can show`, new):

```
# What the chat can show
- Some fenced blocks render as pictures. Use one when a picture explains better than words.
- ```mermaid draws a diagram (Mermaid 11: flowchart, sequence, state, class, ER, gantt). Keep it under about 40 nodes, one diagram per block, and put labels that contain punctuation in double quotes.
- ```svg draws a small picture: one <svg> with a viewBox, no scripts, links or external images.
- Math renders: $…$ inline, $$…$$ on lines of their own.
```

**Security:** the first raw markup on syrup's origin in the chat; §2.12 (DOMPurify, strict Mermaid, shadow roots, `trust: false`).

**Acceptance**

- **`pnpm test:rich`** (new; esbuild bundle of pure modules, like `test-transcript.mjs`):
  - `fenceState`: the spike's 12 cases (opener only, partial closer, closer with trailing spaces, tilde fence closed by backticks, 4-backtick opener closed by 3 or 4, fence in a list, fence in a quote, no final newline, longer closer) plus `$$` blocks.
  - **Every prefix** of `chat-rich-fences`'s reply: a fence never goes from closed back to open, and its kind resolves only after the info line's newline.
  - `trimPartialCloser`; `fenceKind`, `fileKind`.
  - The math guard: `$5 and $10` and `$PATH and $HOME` stay text; `$x^2$`, `$E = mc^2$`, `$r$` and `$$…$$` are math.
  - The normalizer: `\(a\)` → `$a$`; `\[…\]` → `$$…$$`; untouched inside fences and inline code.
  - `mermaidFixes`: each of the 5 breaks becomes the expected string; valid diagrams come back unchanged.
  - `hash` stability; cache keys change with version, theme and width.
  - The grep: no `innerHTML`/`dangerouslySetInnerHTML` under `src/components/rich/` outside `shadow-markup.tsx` and `renderers/math.tsx`.
  - `tokens.ts`: `LIGHT_TOKENS` equals the light `:root` block parsed from `src/app/globals.css`.
  - `export-dom.ts`: the `innerHTML` of a `RichExport` holding a one-rect SVG contains `<rect` (Chromium, §3.0).
  - `prompt.ts`: `# What the chat can show` in `SYRUP_PROMPT` is ≤ 250 tokens (characters ÷ 4).
- **Harness** (needs H1, H3, H4, H10, W1 from 2a.harness):

| Scenario | Content | Assertions |
|---|---|---|
| `chat-rich-fences` (edit) | unchanged | `{count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready] svg[aria-roledescription]", equals: 2}` · `{count: ".chat-log pre code.language-mermaid", equals: 0}` · `{count: ".chat-log figure[data-rich-kind=svg][data-rich-state=ready] .rich-host svg", equals: 1}` (`.rich-host` keeps toolbar icons out of the count) · `{count: ".chat-log .katex", equals: 5}` · `{count: ".chat-log .katex-display", equals: 1}` · `{hidden: "text=$x^2$"}` (replaces `{text: "$x^2$"}`) · the vega-lite, csv and markmap code lines unchanged · `{requests: "POST /api/oc/session/*/message", equals: 0}` · `{external: 0}` · `{box: ".chat-log figure.rich .rich-bar", maxWidth: 342, widths: [390]}`. Variants: `colorScheme: "dark"` |
| `chat-streaming` (edit, once its owner has committed it) | unchanged | Add `{count: ".chat-log figure[data-rich-kind]", equals: 0}` (a python fence stays code). Nothing else: its gap notes are already gone |
| `chat-rich-streaming` (new) | Busy chat, modelled on `chat-streaming.mjs`: the reply is `text(BODY, { open: true, later: true })`, where `BODY` = "Here is the checkout flow:\n\n" + ` ```mermaid\nflowchart TD\n    A[Cart] --> B{Empty?}\n    B -- No --> C[Pay`; `const [reply] = openParts(scenario, c.id)`. Steps: `{ emit: [partStart(reply), ...partDeltas(reply, BODY)], every: 25 }`, `{ settle: true }`, then the assertions | `{count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=pending]", equals: 1}` · `{count: ".chat-log svg[aria-roledescription]", equals: 0}` · `{hidden: "text=C[Pay"}` |
| `chat-rich-streaming-close` (variant) | Same; after the first steps: `{ emit: partDeltas(reply, CLOSER + "\nDone."), every: 25 }` with `CLOSER` = `"]\n```"`; then `{ emit: [partEnd(reply, { text: BODY + CLOSER + "\nDone." }), <message.updated with time.completed>, <session.idle>] }`; then `{ settle: true }` (H10 waits for the render) | `{count: ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready]", equals: 1}` · `{text: "Done."}` · `{hidden: "button:text-is('Stop')"}` |
| `chat-rich-broken` (new; `ago: 25 * MIN`) | (1) a flowchart with `A[Cart (guest)] --> B`; (2) a flowchart with `A -->> B` | `{count: "figure[data-rich-kind=mermaid][data-rich-repaired=autofix][data-rich-state=ready]", equals: 1}` · `{count: "figure[data-rich-kind=mermaid][data-rich-state=source] pre code", equals: 1}` · `{text: "This diagram has a syntax error, so here's its source."}` · `{requests: "POST /api/oc/session/*/message", equals: 0}` |
| `chat-svg-hostile` (new) | The spike's hostile SVG (`libs-pnpm/app/r/svg.tsx` `EVIL`), with each script changed to `document.body.insertAdjacentText("beforeend","PWNED")`, plus `<style>.chat-log{display:none}</style>`; a second SVG reusing `id="g"`; a third SVG with `<style>:host{position:fixed!important;inset:0!important;z-index:2147483647!important}</style>`; a fourth with `<style>rect{fill:image-set("https://example.com/b" 1x)}</style>` and a `<rect style='fill:image-set("https://example.com/c" 1x)'>` | `{count: "figure[data-rich-kind=svg][data-rich-state=ready]", equals: 4}` · `{hidden: "text=PWNED"}` · `{visible: ".chat-log"}` · `{count: "figure[data-rich-kind=svg] :is(script, foreignObject, [onload], animate, set)", equals: 0}` · `{box: ".chat-log figure[data-rich-kind=svg] >> nth=2 >> .rich-host", maxWidth: 760}` (the `:host` one; `box` measures the first match only) · `{visible: "button[aria-label='Send']"}` · step `{click: "textarea"}` before the assertions (Playwright refuses a click whose target an overlay intercepts, so the composer is proven uncovered) · `{external: 0}` |
| `chat-svg-hostile-export` (variant) | `chat-svg-hostile`'s chat with `chat-rich-export`'s steps; the file is opened once with `javaScript: true` and once with `false` | On both opened files: `{hidden: "text=PWNED"}` · `{external: 0}` · `{box: "figure[data-rich-kind=svg] >> nth=2", maxWidth: 760}` |
| `chat-rich-zoom` (new) | `chat-rich-fences`'s chat; step: click (1440) or tap (390) the first diagram | `{visible: "[aria-label='Workspace panel'] figure[data-rich-kind=mermaid][data-rich-state=ready]"}` · `{visible: "[aria-label='Workspace panel'] button:text-is('Fit')"}` |
| `chat-rich-export` (new) | `chat-rich-fences`'s chat; steps: open Share, `{download: "button:text-is('HTML')", save: "export.html"}`, `{openFile: "export.html", javaScript: false}` | `{file: "export.html", contains: ["shadowrootmode=\"open\"", "<rect", "<math"], notContains: ["<script"]}` · on the opened file: `{count: "figure[data-rich-kind=mermaid] svg[aria-roledescription]", equals: 2}`; look at its screenshots at both widths. Variant `colorScheme: "dark"`: the file still `contains` the light `--surface-2` hex from `LIGHT_TOKENS` as a Mermaid fill (`"fill:" + LIGHT_TOKENS.surface2`) |
| `weight-mermaid`, `weight-math`, `weight-svg` (new) | One block each | Used by W1 only |

- **Weight:** `--compare` passes on `/` and the chat with initial growth ≤ 0 (target) and never over 2 KB; `--budgets` passes for core, math, KaTeX, SVG and Mermaid. Then 2a.integrate runs `pnpm ui:weight --update`, so later rounds compare against the new, lower baseline; the commit message gives both figures and says "Preview tab moved out of the initial bundle".
- **Manual:** a local share of the fixture chat at `/c/<id>`, both widths; a local share of a chat holding `chat-svg-hostile`'s four SVGs at `/c/<id>` (no "PWNED", no overlay, the page scrolls and its links work, DevTools shows no request to example.com); "draw the checkout flow and give the formula" against the dev server, then the same in the cloud after the deploy.
- **Day-1 check:** KaTeX CSS loads through a plain `import()` in `next dev` and in a production build (fallback: `next/dynamic` for the math renderer only). (Delta arrival is the streaming owner's to prove.)

**Done when:** at both widths the fixture shows the flowchart, the sequence diagram, inline and display math and the SVG; an open fence shows a skeleton and becomes the diagram when it closes; a broken diagram is autofixed or shown as source; hostile SVG neither runs, fetches nor covers the page, live or shared; the HTML export shows both diagrams with JavaScript off; initial JS did not grow; the gate passes; pushed and deployed.

---

### 3.2b Round 2b: the repair loop (about 1 day; after Round 1 is pushed)

**Scope:** decision 8 as §2.10: the repair agent, the router leash, the client loop, write-back, **Try to fix**, the sidecar filter. The router files are free only once Round 1 is pushed. If Round 1 runs late, 2a ships alone and 2b follows.

**Files**

| Package | Add | Change |
|---|---|---|
| 2b.server | `src/server/engine/repair-prompt.ts` | `src/server/engine/opencode.ts` (agents, `AgentPrompts`, the `promptSuffix` option), `src/server/router/policy.ts` (`isRepairCall`), `src/server/router/core.ts` (the leash and the body rewrite), `scripts/test-router.mjs`, `sidecar/events.ts` (ids and titles) |
| 2b.client | `src/lib/rich/repair.ts`, `scripts/rich-tests/repair.ts` | `src/components/rich/core.tsx` (wire repair, caption, **Try to fix** in the note line and the toolbar), `src/components/rich/renderers/mermaid.tsx` (`repairable` errors) |
| 2b.harness | — | `scripts/ui-harness.mjs`, `scripts/fixtures/ui/_kit.mjs`, `docs/TESTING.md` (H2) |
| 2b.integrate | `scripts/fixtures/ui/chat-rich-repair.mjs` (with variant (e) when Round 3 pushed first) | `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` |

**Interfaces**

```ts
// src/server/engine/repair-prompt.ts
export const REPAIR_TITLE = "syrup:repair"
export const REPAIR_PROMPT: string        // §2.10
// src/server/engine/opencode.ts
export function syrupEngineConfig(routerURL: string, secret: string, opts?: { promptSuffix?: string }): …   // promptSuffix appended to SYRUP_PROMPT for build and plan
// src/server/router/policy.ts
export function isRepairCall(messages: Msg[], tools: unknown): boolean
export function repairBody<T extends { messages: Msg[] }>(body: T): T   // messages[0] → REPAIR_PROMPT only; temperature 0; max_tokens ≤ 2,048
// src/lib/rich/repair.ts — in the core chunk
export type RepairKind = "mermaid" | "vega-lite"
export interface RepairEnv { directory: string; connection: Connection | null; sessionID: string; part(): TextPart | undefined; idle(): boolean; directoryBusy(): boolean }
export type RepairOutcome = { ok: true; source: string; ms: number } | { ok: false; reason: "not-eligible" | "no-agent" | "busy" | "preempted" | "skipped" | "timeout" | "model-error" | "still-invalid"; ms: number }
// "preempted": aborted because the user sent a message; the block becomes manual ("Try to fix") and nothing is memoized
export function sweepRepairChildren(directory: string, connection: Connection | null): Promise<number>   // once per connection; deletes stale syrup:repair children
export function repairEligible(origin: RichOrigin, readOnly: boolean, now: number): "auto" | "manual" | "never"
export function repairPrompt(kind: RepairKind, source: string, error: RichError): string
export function repairOnce(kind: RepairKind, source: string, error: RichError, validate: (s: string) => Promise<boolean>, env: RepairEnv): Promise<RepairOutcome>
export function extractBlock(reply: string): string | null       // the first fenced block's body, else the trimmed reply
export function spliceFence(text: string, original: string, fixed: string): string | null
export function writeBack(env: RepairEnv, kind: RepairKind, original: string, fixed: string): Promise<boolean>
```

**Dependencies:** none.

**Security:** the repair agent has no tools and no MCP (`permission: "deny"`); its reply is only ever diagram source and goes through the same validators and sanitizers; a prompt-injected label can only produce another diagram.

**Acceptance**

- **`pnpm test:router`:** new scenarios: a repair call is recognized only on `fast`, with no tools and the exact prompt head; only free, non-scarce candidates are used and never a paid key; one backend, no failover after a failure; no first token within 4 s → HTTP 400 `syrup_repair_skipped`; output clamped to 2,048; the upstream body's system message is exactly `REPAIR_PROMPT` (an env block, a MEMORY.md index and an `AGENTS.md` in the incoming one are gone), `temperature` is 0, and the user message is unchanged; stickiness untouched; titles still behave as before.
- **`pnpm test:rich`:** `extractBlock` (bare, fenced, wrong language tag, prose around it, two blocks, empty, ```` ```text ````, tilde fence); `spliceFence` (keeps list and quote prefixes; `null` when the original is gone); `repairEligible` (fresh, old, read-only, file, oversize); `repairPrompt` truncates the error at 500 characters; `repairOnce` with a fake `oc` and `directoryBusy()` turning true mid-call → `POST …/abort` and `DELETE` are sent, the outcome is `preempted`, nothing is memoized; the memo stays at 200 entries and survives a throwing `setItem` (QuotaExceeded drops the oldest half).
- **Harness** (needs H2):

| Scenario | Content | Assertions |
|---|---|---|
| `chat-rich-repair` (a) fixed | `ago: 2 * MIN`; a flowchart with `A -->> B`; `engine.replies: [{ match: "-->>", text: "```mermaid\nflowchart LR\n    A --> B\n```" }]` | `{count: "figure[data-rich-kind=mermaid][data-rich-repaired=model][data-rich-state=ready]", equals: 1}` · `{text: "Fixed automatically"}` · `{requests: "GET /api/oc/agent", min: 1}` · `{requests: "POST /api/oc/session", body: "\"parentID\"", equals: 1}` · `{requests: "POST /api/oc/session/*/message", body: "\"agent\":\"repair\"", equals: 1}` · `{requests: "DELETE /api/oc/session/*", equals: 1}` · `{requests: "PATCH /api/oc/session/*/message/*/part/*", equals: 1}` |
| (b) still broken | The reply is broken too: `"```mermaid\nflowchart LR\n    A -->> B\n```"` | `{count: "figure[data-rich-state=source]", equals: 1}` · `{text: "This diagram has a syntax error, so here's its source."}` · `{requests: "POST /api/oc/session/*/message", equals: 1}` · `{requests: "PATCH /api/oc/session/*/message/*/part/*", equals: 0}` |
| (c) old reply | `ago: 2 * DAY` | `{requests: "POST /api/oc/session/*/message", equals: 0}` · `{visible: "figure[data-rich-kind=mermaid] .rich-note button:text-is('Try to fix')"}` (visible at 1440 without hover) |
| (d) no repair agent | `engine.agents` without `repair` | `{requests: "POST /api/oc/session/*/message", equals: 0}` · `{count: "figure[data-rich-state=source]", equals: 1}` |

- **Bench:** `pnpm bench:agent` "before" on the running server; the founder restarts `pnpm dev` (§6 I4, before the push); `pnpm bench:agent` "after"; both tables in the commit message (§3.0).
- **Weight:** initial unchanged (`repair.ts` lives in the core chunk); `--budgets` still passes for the core (≤ 20 KB).
- **Day-1 checks** (isolated engine, the opencode spike's `launch.mjs` recipe; never the dev server's engine):
  - `GET /agent` lists `repair`.
  - A build turn still edits a file without a permission prompt after `task.repair: deny` (fallback: drop the task deny; `repair` then shows in the task tool's list, which is harmless).
  - **Plan keeps its own rules:** after the config change, `GET /agent` still shows plan's `edit` and `bash` rules as deny, and a plan-mode turn told to "create x.txt" does not create it. If either fails: drop the task deny from plan only (`repair` then shows in plan's task list, which is harmless).
  - **A real repair request is recognized:** capture the chat-completions body of one repair call from the isolated engine against a mock provider (the spike's `repair.mjs` with its mock), and assert `isRepairCall(body.messages, body.tools) === true` on it. Copy that body into `scripts/test-router.mjs` as the rewrite case's input, with paths, memory text and any key replaced by placeholders.
  - A PATCH of a completed text part persists across a reload and emits `message.part.updated` (fallback: memo only; shares show the source).
- **Manual, local then cloud:** "write this exact block: …" with a broken diagram; it is repaired or shown as source; after a reload it is still fixed and makes no call; a share of the chat shows the fixed diagram.

**Done when:** a deliberately broken diagram in a fresh reply is repaired by one hidden call (fixture and live), shown as source when the repair fails, stays fixed after a reload and in a share; a message sent during a repair aborts it; bench (after the restart) shows no slower first token; the gate passes; pushed and deployed.

---

### 3.3 Round 3: charts, tables, mind maps (about 1½ days)

**Scope:** ```` ```vega-lite ```` (also `vegalite`, `vl`, and `json` whose `$schema` mentions vega-lite) becomes a chart; ```` ```csv ````, ```` ```tsv ````, record-shaped ```` ```json ```` and GFM tables wider than 8 columns become sortable tables; ```` ```markmap ```` becomes a mind map; Vega joins the repair loop.

**Files**

| Package | Add | Change |
|---|---|---|
| 3.renderers | `src/components/rich/renderers/{vega,table,markmap}.tsx`, `src/lib/rich/{vega-lint,csv,markmap-tree}.ts`, `scripts/rich-tests/{vega,csv,markmap}.ts` | `src/lib/rich/loaders.ts`, `src/lib/rich/autofix.ts` (`lenientJson`), `src/components/markdown.tsx` (the `table` override) |
| 3.harness | — | `scripts/js-weight.mjs` (W2), `scripts/fixtures/js-budgets.json`, `docs/TESTING.md` |
| 3.integrate | `scripts/fixtures/ui/{chat-rich-charts,weight-vega,weight-table,weight-markmap}.mjs` | `src/server/engine/prompt.ts`, `scripts/fixtures/ui/{chat-rich-fences,chat-rich-repair}.mjs`, `docs/ROADMAP.md` |

- **If Round 1 is late** and Round 3 pushes before 2b: 3.renderers depends only on 2a; Vega's errors are already marked `repairable`, and they show the source until 2b wires the loop. Variant (e) of `chat-rich-repair` then moves into 2b.integrate (the file doesn't exist yet), and 3.integrate skips that edit.

**Dependencies:** `vega@6.4.0`, `vega-lite@6.4.3`, `vega-interpreter@2.3.2`, `@tanstack/react-table@9.2.6`, `@tanstack/react-virtual@3.14.13`, `markmap-view@0.18.12`, `markmap-common@0.18.9`, `mdast-util-from-markdown@2.0.3`; dev `@types/mdast@4.0.4`. All installed by 2a.deps.

**Interfaces**

```ts
// src/lib/rich/vega-lint.ts — pure, zero dependencies; Round 7's show_chart imports it
export interface VegaLintIssue { path: string; message: string; repairable: boolean }
export function lintVegaLite(spec: unknown): VegaLintIssue[]
// checks: an object with mark or a composition key; mark type in the enum; channel names; field types and aggregates in their enums;
// data present and inline (data.url → "Charts here can't load data from the web.", not repairable); ≤ 5,000 rows;
// encoded fields exist in data.values[0] unless transforms exist; href encodings and URL image marks → not repairable

// src/lib/rich/autofix.ts — Round 3 addition
export function lenientJson(text: string): { value: unknown } | { error: string; line?: number }   // strips // and /* */ comments and trailing commas; unwraps a double-encoded string

// src/lib/rich/csv.ts — pure (a copy of file-preview's parser plus types; file-preview switches to it in Round 4)
export type ColumnType = "number" | "date" | "text"
export function parseDelimited(text: string, delimiter: "," | "\t", maxRows?: number): string[][]
export function columnTypes(rows: string[][]): ColumnType[]       // number when ≥ 90% of non-empty cells parse; ISO dates; else text
export function compareCells(t: ColumnType): (a: string, b: string) => number   // numbers numeric, text numeric-aware collator, empty cells last
export function toCsv(rows: string[][], o?: { formulaSafe?: boolean; delimiter?: "," | "\t" }): string
export function tableFromJson(v: unknown): { columns: string[]; rows: string[][] } | null       // ≥ 3 flat objects, ≤ 50 columns, scalar values

// src/lib/rich/markmap-tree.ts — pure (mdast-util-from-markdown)
export interface MindNode { content: string /* escaped HTML */; children: MindNode[] }
export function mindTree(markdown: string, maxNodes?: number): { root: MindNode; nodes: number; clipped: boolean }   // headings and list items; ≤ 500 nodes
```

**Renderer specifics**

- **`vega.tsx`:** `validate`: `lenientJson` (autofix) → `lintVegaLite` → `compile(spec, { config: themeConfig(tokens), logger })` (a throw or an "Invalid …" warning is a repairable `schema` error) → `parse(vg, null, { ast: true })` → `new View(runtime, { renderer: "none", expr: expressionInterpreter, loader: denyLoader, logger })` → `runAsync()` ("Infinite extent" is a repairable `empty` error). `toStatic`: `width: "container"` or none → the width bucket minus padding; height defaults to 240; `view.toSVG()` → sanitizer. Panel `View`: an interactive `View` (`renderer: "svg"`, default title tooltips, the same interpreter and loader), resized by a `ResizeObserver`, `finalize()` on unmount. `denyLoader` = `{ ...vega.loader(), sanitize: async () => { throw new Error("Charts here can't load data from the web.") } }`.
- **`table.tsx`:** TanStack v9 `useTable` with `rowSortingFeature` and a sorted row model (API as in the spike's `libs-pnpm/app/r/table.tsx`); `useVirtualizer` past 200 rows (rows 28 px on fine pointers, 36 px on coarse; overscan 10), with `// eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns fresh functions by design`. The first activation of a column sorts descending, the second ascending, the third clears. Sticky header; caption "1,000 rows · 5 columns"; **Copy CSV**; for JSON fences a **Table · JSON** toggle. Layout per §2.8 (compact: 20 rows plus **Open table (N rows)**; otherwise 420 px inner scroll). Panel: full height. `toStatic` (export only): ≤ 500 rows. Caps: 2 MB of text, 50,000 rows ("Showing the first 50,000 rows."). Ragged rows are padded with a note.
- **GFM tables:** the `table` override counts header cells; more than 8 and `final` → `RichBlock` with kind `table` and the cell text (links and code lose formatting); otherwise today's `.md-table`.
- **`markmap.tsx`:** chat: `Markmap.create(svg, { autoFit: true, duration: 0, zoom: false, pan: false }, root)` in an offscreen SVG, then `fit()` and serialize. The offscreen SVG is created in the light DOM, after markmap's CSS is injected, with `position:absolute; left:-10000px; visibility:hidden` (measuring needs an attached, laid-out SVG, so never `display:none`), and removed afterwards. The serialized markup skips the agent-SVG sanitizer: markmap draws labels in `<foreignObject>`, which that sanitizer forbids, and `mindTree` has already escaped every label (§2.12); `StaticRender.css` carries markmap-view's own CSS (it injects global CSS, which a shadow root doesn't see); height 320 px; colours through the `--markmap-*` variables set on the host from tokens. Panel: interactive, `duration: reducedMotion ? 0 : 300`.

**Prompt** (append):

```
- ```vega-lite draws a chart: a Vega-Lite v6 JSON spec with its rows inline under "data": {"values": [...]}; never a URL.
- ```csv, or ```json holding an array of objects, shows a sortable table.
- ```markmap draws a mind map from a Markdown outline (headings and bullets).
```

**Security:** interpreter, deny-all loader, sanitized SVG, escaped markmap labels, every picture in `.rich-clip`, formula-safe CSV (§2.12).

**Acceptance**

- **`pnpm test:rich`:** `lintVegaLite` on the spike's 9 broken specs (each caught with a clear message) and 3 valid ones; `lenientJson`; CSV (quoted commas, doubled quotes, CRLF, newlines inside quotes, ragged rows, a `toCsv` round trip, formula-safe prefixes); `columnTypes` and `compareCells`; `tableFromJson` (records yes; nested, < 3 rows, > 50 columns no); `mindTree` (escaping, 500-node clip).
- **Harness:**

| Scenario | Content | Assertions |
|---|---|---|
| `chat-rich-fences` (edit) | unchanged | `{count: "figure[data-rich-kind=vega-lite][data-rich-state=ready] .mark-rect path", equals: 7}` · `{count: "figure[data-rich-kind=table] tbody tr", equals: 20}` · `{count: "figure[data-rich-kind=markmap][data-rich-state=ready] g.markmap-node", min: 10}` · code counts for vega-lite, csv and markmap become 0 |
| `chat-rich-charts` (new) | A 7-bar weekday chart; a temporal line chart with 2 series (`channel`: web, store); a 1,000-row CSV `order_id,placed_at,customer,total,status` whose totals are distinct, smallest `0.99`, largest `4999.99`; a ```` ```json ```` array of 5 records; a 12-column GFM table of 6 rows | `{count: "figure[data-rich-kind=vega-lite][data-rich-state=ready]", equals: 2}` · `{count: "figure[data-rich-kind=vega-lite] .mark-line path", equals: 2}` · `{count: "figure[data-rich-kind=table]", equals: 3}` · `{count: ".chat-log .md-table", equals: 0}` · `{visible: "figure[data-rich-kind=table] button:text-is('JSON')"}` · at 1440: `{count: "table[aria-rowcount='1001'] tbody tr", max: 60}` · at 390: `{count: "table[aria-rowcount='1001'] tbody tr", equals: 20}` and `{visible: "text=Open table (1,000 rows)"}` |
| `chat-rich-charts` sort (steps) | Click (1440) or tap (390) `table[aria-rowcount='1001'] th button:has-text('total')` twice | `{visible: "table[aria-rowcount='1001'] tbody tr:first-child td:has-text('0.99')"}` |
| `chat-rich-repair` (e) Vega | `ago: 2 * MIN`; the weekday spec with `"field": "order"` (the data says `orders`); a reply with the fixed spec | `{count: "figure[data-rich-kind=vega-lite][data-rich-repaired=model][data-rich-state=ready]", equals: 1}` · `{requests: "POST /api/oc/session/*/message", body: "vega-lite", equals: 1}` |
| `weight-vega`, `weight-table`, `weight-markmap` | One block each | W1 |

- **Weight:** initial unchanged; budgets for Vega, table and markmap.
- **Perf (W2):** `pnpm ui:weight --compare --budgets --perf` on the production build, with `chat-rich-fences` and `chat-rich-charts` in their typewriter-running variants (`ago: 0`): the longest main-thread task at 1440 px and 1× CPU is ≤ 300 ms (gate); 390 px at 4× CPU is reported. If the 4× report shows Vega tasks over 400 ms, open a follow-up for a Vega worker; it does not block the round.

**Done when:** a bar chart, a line chart and a 1,000-row table render in the chat at both widths, with the perf gate met; sorting works on a phone; the gate passes; pushed and deployed.

---

### 3.4 Round 4: files in the Preview tab (about 1½ days)

**Scope:** `.mmd` and `.mermaid`, `.vl.json` and `.vega-lite.json` (plus `.json` sniffed as Vega-Lite), `.svg` as sanitized inline SVG, `.csv` and `.tsv` on the rich table, `.excalidraw` (view), `.geojson` (MapLibre), `.ipynb` (static cells and saved outputs). The Preview already reloads 900 ms after file events.

**Files**

| Package | Add | Change |
|---|---|---|
| 4.files | `src/components/rich/renderers/{excalidraw,geojson,notebook}.tsx`, `src/lib/rich/{sniff,notebook,geojson,excalidraw-safety,excalidraw-assets}.ts`, `scripts/vendor-assets.mjs`, `scripts/rich-tests/files.ts` | `src/components/file-preview.tsx` (dispatch through `fileKind`, `sniffJson` and `RichView`; CSV/TSV and SVG onto the rich renderers; delete its own `TableView` and `parseDelimited`), `src/components/rich/file-loaders.ts`, `.gitignore` (`/public/vendor/`) |
| 4.integrate | `scripts/fixtures/ui/{panel-preview-kinds,weight-excalidraw,weight-geojson,weight-notebook}.mjs` | `package.json` (`dev` and `build` run `vendor-assets` first), `src/proxy.ts` (`/^\/vendor\//` added to `PUBLIC`; lane B has no Round 4 package, so the integrator owns it this round), `src/server/engine/prompt.ts`, `scripts/fixtures/js-budgets.json`, `docs/TESTING.md`, `docs/ROADMAP.md` |

- **Why `src/proxy.ts`:** the matcher's static-extension group has no `mjs`, and `PUBLIC` has no `/vendor`, so in the cloud a signed-out request for `/vendor/maplibre/maplibre-gl-worker.mjs` gets a 307 to `/signin` (a shared chat's map would break). `PUBLIC` is the narrower fix: it covers only the copied vendor assets, not every `.mjs` path.

**Dependencies:** `@excalidraw/excalidraw@0.18.1`, `maplibre-gl@6.13.0`, `anser@2.3.5`, installed by 2a.deps. `fileKind` in `kinds.ts` already lists every file kind from Round 2a; this round only adds loaders.

**Interfaces**

```ts
// src/lib/rich/sniff.ts
export function sniffJson(text: string): "vega-lite" | "excalidraw" | "geojson" | "notebook" | null
// $schema mentioning vega-lite · "type": "excalidraw" · "type": "FeatureCollection" | "Feature" | a geometry type · an "nbformat" key
// src/lib/rich/notebook.ts
export type NbOutput = { kind: "stream"; name: "stdout" | "stderr"; text: string } | { kind: "error"; ename: string; evalue: string; traceback: string[] } | { kind: "mime"; mime: string; data: string | object } | { kind: "skipped"; reason: string }
export interface NbCell { type: "markdown" | "code" | "raw"; source: string; count: number | null; outputs: NbOutput[] }
export function parseNotebook(text: string): { ok: true; language: string; cells: NbCell[] } | { ok: false; error: string }   // nbformat 4, ≤ 500 cells
export function pickOutput(data: Record<string, unknown>): NbOutput
// MIME priority: application/vnd.vegalite.v6+json, v5, v4 → vega · image/svg+xml → svg · image/png, jpeg, gif → <img src=data:> · text/html → sanitized HTML
// · text/markdown → Markdown · text/latex → TexSlot · application/json → pretty <pre> · text/plain → <pre>; JS and widget outputs → "Interactive output not shown."
// text/html: the notebook HTML profile of §2.12 (no style attributes, no srcset, src only data:image/*, https links with target=_blank rel="noopener noreferrer")
// src/lib/rich/geojson.ts
export function checkGeojson(v: unknown): { ok: true; bbox: [number, number, number, number]; features: number } | { ok: false; error: string }   // ≤ 20,000 features
// src/lib/rich/excalidraw-safety.ts
export function scrubScene(scene: unknown): { scene: unknown; removed: { embeds: number; links: number; files: number } }
```

**Renderer specifics**

- **`excalidraw.tsx` (view):** imports `./excalidraw-assets` first (`window.EXCALIDRAW_ASSET_PATH = "/vendor/excalidraw/"`) and `@excalidraw/excalidraw/index.css`; `<Excalidraw initialData={restore(scrubScene(json))} viewModeEnabled zenModeEnabled theme={scheme} validateEmbeddable={() => false} onLinkOpen={httpsOnly} />` in an `h-full min-h-[400px]` box. Never `exportToSvg` with inlined fonts (under Turbopack that pulls a 717 KB WASM chunk onto the main thread).
- **`geojson.tsx`:** `setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs")` at module top; `maplibre-gl/dist/maplibre-gl.css`; a blank style (one background layer in `--surface`); fill `--accent-soft`, line and circles `--accent`; `fitBounds(bbox, { padding: 24 })`; click popups list the first 8 properties as escaped text. A **Basemap** toggle loads OpenFreeMap `https://tiles.openfreemap.org/styles/positron` (light) or `…/dark` with attribution, remembered in `syrup.map.basemap`. No WebGL 2: source view plus "This browser can't draw maps (WebGL 2 is off)."
- **`notebook.tsx`:** Markdown cells through `Markdown` (math included); code cells through `highlight.ts` with `In [n]`; stream and error outputs as `<pre>` with anser colour spans (no `innerHTML`); outputs per `pickOutput`; text outputs capped at 20 KB each with a note; cells carry `data-nb-cell`.
- **`scripts/vendor-assets.mjs`:** copies `node_modules/@excalidraw/excalidraw/dist/prod/fonts/**` to `public/vendor/excalidraw/fonts/` (all of them, about 14 MB, build output only) and `node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs` to `public/vendor/maplibre/`, only when size or mtime differ; prints one line. The running dev server serves new `public/` files without a restart; run the script once by hand while building.
- **Errors in files:** invalid JSON, invalid GeoJSON, an old notebook format: the error line, the source, and **Ask the agent to fix** (prefills "The file `<rel>` doesn't load: <error>. Please fix it."). Mermaid and Vega files are never repaired silently.

**Prompt** (append):

```
- Files you write render in the user's Preview tab: .mmd (Mermaid), .vl.json (Vega-Lite), .csv, .svg, .excalidraw (drawings), .geojson (maps) and .ipynb (notebooks, with their saved outputs).
```

**Security:** sanitized SVG and notebook HTML (URL and CSS hooks, no style attributes) in shadow roots inside `.rich-clip`; scrubbed Excalidraw scenes; no tile requests until the user turns on a basemap.

**Acceptance**

- **`pnpm test:rich`:** `fileKind` table; `sniffJson`; `parseNotebook` and `pickOutput`; `checkGeojson` (FeatureCollection, Feature, bare geometry, invalid); `scrubScene` (embeddable, `javascript:` link, `http:` link and remote image removed).
- **Harness** (`panel-preview-kinds`, one variant per file, each opened with `panel: { tab: "preview", file }`, which is one tap in Files; every variant also asserts `{external: 0}`):

| File | Assertion (inside `[aria-label='Workspace panel']`) |
|---|---|
| `diagrams/checkout.mmd` | `figure[data-rich-kind=mermaid][data-rich-state=ready] svg[aria-roledescription]` visible |
| `diagrams/broken.mmd` (`A -->> B`) | `button:has-text('Ask the agent to fix')` visible |
| `charts/orders.vl.json` | `figure[data-rich-kind=vega-lite][data-rich-state=ready]` visible |
| `charts/stores.json` (Vega-Lite `$schema`) | `figure[data-rich-kind=vega-lite][data-rich-state=ready]` visible |
| `drawings/board.excalidraw` (3 rectangles, 2 arrows, a text "Webhook") | `figure[data-rich-kind=excalidraw] canvas` visible |
| `maps/stores.geojson` (3 points, 1 polygon) | `{count: "figure[data-rich-kind=geojson][data-rich-state=ready] canvas.maplibregl-canvas, figure[data-rich-kind=geojson][data-rich-state=source]", equals: 1}` (WebKit may lack WebGL 2 headless) |
| `notebooks/analysis.ipynb` (5 cells: a markdown heading; code with stdout; an ANSI-coloured traceback; an HTML output holding a table, a remote `<img src="https://example.com/x.png">` and a `<div style="position:fixed;inset:0">`; a PNG output) | `{count: "[data-nb-cell]", equals: 5}` · `{count: "[data-nb-cell] img[src^='data:image/png']", equals: 1}` · `{count: "figure[data-rich-kind=notebook] table", equals: 1}` · `{count: "figure[data-rich-kind=notebook] img[src^='http']", equals: 0}` · `{count: "[data-nb-cell] span[style*=color]", min: 1}` (anser's own spans, built without `innerHTML`) · `{external: 0}` |
| `assets/logo.svg` | `figure[data-rich-kind=svg][data-rich-state=ready] .rich-host svg` visible |
| `assets/evil.svg` (the hostile SVG, plus the `:host` overlay rule and both `image-set(…)` vectors of `chat-svg-hostile`) | `{hidden: "text=PWNED"}` · `{count: "figure[data-rich-kind=svg] [onload]", equals: 0}` · `{box: "figure[data-rich-kind=svg]", maxWidth: 760}` · `{external: 0}` |

  `panel-preview-csv` keeps passing (24 rows, `Chen, Wei` visible).
- **Weight:** initial unchanged; budgets for Excalidraw, MapLibre and the notebook (W1 with panel steps).
- **After a production build:** `public/vendor/excalidraw/fonts/Excalifont/*.woff2` and `public/vendor/maplibre/maplibre-gl-worker.mjs` exist.
- **Cloud, after the deploy (§6 I5):** a signed-out `curl -sI https://syrup.syedsarib.com/vendor/maplibre/maplibre-gl-worker.mjs` answers 200, not 307.

**Done when:** each kind has a fixture and a screenshot at both widths, opens in one tap from Files, and makes no third-party request; the gate passes; pushed and deployed.

---

### 3.5 Round 5: the separate-origin HTML/React preview (about 2 days)

**Scope:** agent-written single-file HTML and React run on the preview origin, never the app's. Device widths 390, 768 and 1280; console messages in a collapsible strip; an import map to esm.sh. `.html` files in Preview move off today's `srcdoc` frames. html, jsx and tsx fences in the chat get **Preview**.

**Architecture**

```
app (syrup.syedsarib.com · 127.0.0.1:3000)                    preview shell (syrup-preview.vercel.app · 127.0.0.1:4211)
 PreviewFrame ── <iframe src="{origin}/#n={nonce}"              preview-shell/index.html, the only document either serves
                  sandbox="allow-scripts allow-forms allow-modals"   ← ready
                  referrerpolicy="no-referrer" title="Preview of …"> → render { kind: "html" | "react", source, title }   (once, targetOrigin "*")
                                                                ← rendered · error · console · resize · nav · open · pong
 navigation guard: after every iframe load past "rendered", post ping; no pong within 1 s → remove the frame, say so, offer Reload preview
```

- **Every message** is `{ syrup: "preview", v: 1, nonce, type, … }`.
- **The parent accepts** only when `event.source === iframe.contentWindow`, the nonce matches, the type is on the list, the JSON is ≤ 16 KB, and fewer than 100 messages arrived in the last second. A second `ready` after `render` counts as navigation.
- **The shell** renders nothing when `window.top === window`; reads the nonce from `location.hash`; accepts `render` only once, only when `event.source === parent`, the nonce matches and `event.origin` matches `^https://syrup\.syedsarib\.com$|^https://syrup-blush\.vercel\.app$|^http://(127\.0\.0\.1|localhost):\d+$`.
- **html:** `document.open(); document.write(PRELUDE + source); document.close()`.
- **react:** a written document with an import map, `<div id="root">` and a module script:
  1. Load `https://esm.sh/sucrase@3.35.1`.
  2. Scan import specifiers; anything outside the allow-list → `error` "Only these libraries are available: react, react-dom, recharts, lucide-react, d3, three, papaparse, mathjs, lodash."
  3. `transform(source, { transforms: ["jsx", "typescript"], jsxRuntime: "automatic", production: true })`.
  4. Import a `blob:` URL of the result; render its default export into `#root` inside an error boundary; no default export → `error` "The file needs a default export: a React component."
  - **Import map:** `react` and `react/` → `https://esm.sh/react@19.2.8` (and `/`); `react-dom` and `react-dom/` → `https://esm.sh/react-dom@19.2.8`; `recharts` → `https://esm.sh/recharts@3.10.1?external=react,react-dom`; `lucide-react` → `https://esm.sh/lucide-react@1.52.0?external=react,react-dom`; `d3` → `https://esm.sh/d3@7.9.0`; `three` → `https://esm.sh/three@0.186.1`; `papaparse` → `https://esm.sh/papaparse@5.7.0`; `mathjs` → `https://esm.sh/mathjs@15.2.0`; `lodash` and `lodash-es` → `https://esm.sh/lodash-es@4.18.1`.
- **PRELUDE** (first in every written document, since `document.open()` wipes listeners):
  - Forwards `console.*`, `error` and `unhandledrejection` (each argument stringified, ≤ 2 KB).
  - Installs an in-memory `localStorage`/`sessionStorage` shim (an opaque origin throws on access).
  - Turns link clicks into `nav` (relative) or `open` (https); other schemes are dropped.
  - Posts `resize` from a `ResizeObserver`, answers `ping` with `pong`, posts `rendered` on load.
  - Limits itself to 100 messages per second.
- **Headers:** one source, `preview-shell/vercel.json`. The local listener sends the same headers with `frame-ancestors http://127.0.0.1:* http://localhost:*`.
- **Images and fetches reach esm.sh only** (plus `data:` and `blob:`). Scripts and styles may come from all five CDNs, but unpkg and jsDelivr serve files anyone can publish and jsDelivr publishes per-file hit statistics, so an image or fetch there would be a low-rate beacon for a prompt-injected page.

```json
{
  "cleanUrls": true,
  "headers": [{ "source": "/(.*)", "headers": [
    { "key": "Content-Security-Policy", "value": "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; img-src data: blob: https://esm.sh; media-src data: blob:; connect-src https://esm.sh; worker-src blob:; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors https://syrup.syedsarib.com https://syrup-blush.vercel.app" },
    { "key": "X-Content-Type-Options", "value": "nosniff" },
    { "key": "Referrer-Policy", "value": "no-referrer" },
    { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), clipboard-read=()" },
    { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
    { "key": "X-Robots-Tag", "value": "noindex, nofollow" },
    { "key": "Cache-Control", "value": "no-cache" }
  ]}]
}
```

**Files**

| Package | Add | Change |
|---|---|---|
| 5.shell | `preview-shell/index.html`, `preview-shell/vercel.json`, `src/server/preview-server.ts`, `src/lib/preview-protocol.ts`, `scripts/test-preview.mjs` | `src/server/boot.ts` (start the listener after the engine, local mode; log and continue on failure) |
| 5.frame | `src/components/rich/{preview-frame,device-bar}.tsx`, `src/components/rich/renderers/preview.tsx` (adapts `PreviewFrame` to `Renderer` for html and react), `src/lib/preview-origin.ts` | `src/components/rich/file-loaders.ts` (html, react), `src/components/file-preview.tsx` (`HtmlView` → `PreviewFrame` with `inlineHtml`'s output; **Run as preview** for `.jsx`/`.tsx`; **Open in new tab**), `src/lib/html-inline.ts` (drop the NAV script) |
| 5.harness | — | `scripts/ui-harness.mjs`, `scripts/js-weight.mjs` (sets `SYRUP_PREVIEW_PORT` to a free port next to `SYRUP_ROUTER_PORT`), `docs/TESTING.md` (H6, H7) |
| 5.integrate | `scripts/fixtures/ui/{panel-preview-html,panel-preview-react,panel-preview-recharts,chat-preview-fence,preview-attack,preview-navigate,weight-preview}.mjs` | `src/server/engine/prompt.ts`, `package.json` (`test:preview`), `scripts/fixtures/js-budgets.json`, `docs/ROADMAP.md` |

**Interfaces**

```ts
// src/lib/preview-protocol.ts (the shell inlines the same constants; test:preview checks they match)
export const PREVIEW_V = 1
export type ParentToShell = { syrup: "preview"; v: 1; nonce: string } & ({ type: "render"; kind: "html" | "react"; source: string; title: string } | { type: "ping" })
export type ShellToParent = { syrup: "preview"; v: 1; nonce: string } & (
  | { type: "ready" } | { type: "rendered" } | { type: "pong" }
  | { type: "error"; message: string; line?: number; stack?: string }
  | { type: "console"; level: "log" | "info" | "warn" | "error"; args: string[] }
  | { type: "resize"; height: number } | { type: "nav"; href: string } | { type: "open"; href: string })
export function acceptShellMessage(e: MessageEvent, frame: HTMLIFrameElement | null, nonce: string): ShellToParent | null
export const PREVIEW_LIBS: readonly string[]          // react, react-dom, recharts, lucide-react, d3, three, papaparse, mathjs, lodash, lodash-es
export function canRunReact(source: string): { ok: true } | { ok: false; reason: string }   // a default export and allow-listed imports only

// src/lib/preview-origin.ts
export function previewOrigin(remote: boolean): string
// NEXT_PUBLIC_SYRUP_PREVIEW_ORIGIN when set; else remote ? "https://syrup-preview.vercel.app" : "http://127.0.0.1:4211"

// src/server/preview-server.ts
export function previewPort(): number                 // server-only SYRUP_PREVIEW_PORT, default 4211 (NEXT_PUBLIC_ values are inlined at build, so a second
                                                      // server such as js-weight's `next start` could not move off 4211 and would collide with the dev server)
export function previewHeaders(local: boolean): Record<string, string>   // from preview-shell/vercel.json; local swaps frame-ancestors
export function startPreviewServer(): Promise<{ origin: string } | { error: string }>
// globalThis guard like the router; binds 127.0.0.1 only; GET and HEAD "/" with Host 127.0.0.1:<port> or localhost:<port> get the shell
// (read from preview-shell/index.html per request); any other path → 404, any other method → 405, any other Host → 404; never Set-Cookie or CORS

// src/components/rich/preview-frame.tsx
export interface PreviewFrameProps { kind: "html" | "react"; source: string; title: string; onNavigate?(rel: string): void }
```

**`PreviewFrame` rules**

- A fresh iframe and nonce per render, file reloads included.
- **Navigation guard:** after `rendered`, every iframe `load` triggers a `ping`. No `pong` within 1 s, or a second `ready`, means the page left the shell: the frame is removed and the panel shows "The page tried to navigate away." with **Reload preview** (a fresh frame and nonce). It never reloads by itself, so a page that navigates on load can't loop.
- **Ready timeout 6 s:** `The preview page didn't load (${new URL(previewOrigin(remote)).host}).` with **Retry** and **Show source**. The host comes from the mode, so the cloud never shows a local address. React: a `rendered` timeout of 15 s shows "Still loading libraries…" (not an error); after 45 s without `rendered`, "Couldn't load the libraries from esm.sh." with **Retry**.
- **Console strip:** collapsible, with an error-count badge; the last 200 entries of 2 KB each; **Copy**; **Ask the agent to fix** (prefills the first error).
- **DeviceBar:** **Fit · 390 · 768 · 1280** on desktop (phones: Fit only), scaled with `transform` to the panel width; the wrapper carries `data-width`.
- `nav` → `resolveAsset` → `panel.openFile`; `open` → https only, `window.open(href, "_blank", "noopener,noreferrer")`.
- **Open in new tab** keeps today's blank-tab wrapper (opener nulled): the app puts an iframe to the preview origin in it, listens on the new window, and posts `render` after `ready`. The tab's origin is the app's, so the shell's origin check passes.
- No message ever carries tokens, cookies, engine URLs, user ids or workspace ids.

**Entry points**

- `.html` files: `PreviewFrame` with `inlineHtml`'s output, run on open (as today, but on the preview origin).
- `.jsx`/`.tsx` files: code, plus **Run as preview** when `canRunReact` says ok. They never run on their own.
- html, jsx and tsx fences: code plus **Preview** → `panel.openBlock` → the panel runs it. Read-only views: no button.

**Prompt** (append):

```
- To show a working page or component, write one self-contained file: an .html page, or a .jsx/.tsx file whose default export is a React component. It runs in the user's Preview tab. React files may import only react, react-dom, recharts, lucide-react, d3, three, papaparse, mathjs and lodash. Pages may load scripts and styles from esm.sh, cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com and cdn.tailwindcss.com, and fonts from Google Fonts; images must be inline SVG or data: URLs; nothing else loads.
```

**Dependencies:** none in the app. The preview origin loads the pinned allow-list from esm.sh (§3.0), and sucrase only for React.

**Security:** agent code runs only in an opaque origin on another site (locally another port, behind Round G's guard); no `allow-same-origin`, `allow-popups`, `allow-top-navigation` or `allow-downloads`; content arrives only by postMessage, never by URL; egress limited to the CDN list.

**Known limit:** the app's Vercel branch and preview deployments (generated `*.vercel.app` URLs) are not in the shell's `frame-ancestors`, so previews work only on the two production domains and locally. Branch deployments show the 6 s "didn't load" note.

**Acceptance**

- **First, a ½-hour check:** sucrase from esm.sh transforms a TSX counter, and the import map resolves recharts against one React (fallback: esm.sh's own `?jsx` build of the file through a blob).
- **`pnpm test:preview`** (Node; bundles and starts the listener on a free port through `SYRUP_PREVIEW_PORT`):
  - `GET /` gives 200 HTML; `HEAD /` 200; `GET /x` 404; `POST /` 405; `Host: evil.test` 404.
  - Every response carries the headers from `vercel.json` with the local `frame-ancestors`; none carries `Set-Cookie` or `Access-Control-*`.
  - `vercel.json` parses, its CSP ends with the two app origins, and its `img-src` and `connect-src` name no host but esm.sh.
  - `acceptShellMessage` refuses a wrong source, nonce, type or size; `canRunReact` refuses a missing default export and a non-listed import.
  - The shell's inline protocol constants equal `preview-protocol.ts`'s.
- **Harness** (needs H6, H7; preview frames' own console messages are notes, not failures):

| Scenario | Content | Assertions |
|---|---|---|
| `panel-preview-html` | `web/counter.html`: a button "Clicked 0 times" with an inline script, `web/style.css` | `{visible: "iframe[sandbox='allow-scripts allow-forms allow-modals'][src^='http://127.0.0.1:4211']"}` · `{frame: "iframe[title^='Preview of']", text: "Clicked 0 times"}`; step `{frameClick: ["iframe[title^='Preview of']", "button"]}` · `{frame: …, text: "Clicked 1 times"}` · `{count: "text=Not found in the workspace", equals: 0}` · at 1440: step `{click: "button:text-is('390')"}` → `{visible: "[data-width='390']"}` |
| `panel-preview-react` | `web/Counter.jsx` (default export, `useState`); step: **Run as preview** | frame text "Count: 0"; after `frameClick` "Count: 1" |
| `panel-preview-recharts` | `web/Chart.jsx` importing recharts; `allowExternal: ["https://esm.sh"]` (replay) | `{frame: …, count: "svg.recharts-surface", equals: 1}` |
| `chat-preview-fence` | A chat with a ```` ```jsx ```` counter fence | `{count: ".chat-log iframe", equals: 0}`; step: click **Preview** → panel frame text "Count: 0" |
| `preview-attack` | `web/attack.html` tries `document.cookie`, `parent.document`, `localStorage`, `fetch("http://127.0.0.1:3000/api/oc/session")` and `top.location = "https://example.com"` (each in try/catch), and writes each result into its own page | frame texts "cookie: blocked", "parent: blocked", "storage: memory", "fetch: blocked" (the CSP stops the fetch before any request) · `{visible: ".chat-log"}` (the app kept its route) |
| `preview-navigate` | `web/leave.html`: a button whose click runs `location.href = "https://example.com"`; step `{frameClick: ["iframe[title^='Preview of']", "button"]}` | `{text: "The page tried to navigate away."}` · `{visible: "button:text-is('Reload preview')"}` · `{count: "[aria-label='Workspace panel'] iframe[title^='Preview of']", equals: 0}` |
| `weight-preview` | the HTML file in Preview | W1 |

- **Weight:** initial unchanged; the preview frame ≤ 10 KB.
- **Cloud** (after §6 I1): an HTML file's Preview shows frame origin `https://syrup-preview.vercel.app` in DevTools; `document.cookie` throws there; `curl -sI https://syrup-preview.vercel.app/` shows the CSP and no `Set-Cookie`; `curl -sI https://syrup-preview.vercel.app/x` is 404.

**Done when:** a React counter and a Recharts chart the agent wrote run in the Preview at both widths; a page that reads `document.cookie` gets nothing; the cloud Preview runs on `syrup-preview.vercel.app`; the gate passes; pushed and deployed.

---

### 3.6 Round 6: Excalidraw, editable, round-trip (about 1½ days)

**Scope:** `.excalidraw` files open editable in the panel; changes save back to the file; **Send to agent** prefills the composer; **Edit as drawing** turns a rendered Mermaid block into a new `.excalidraw` file.

**Files**

| Package | Add | Change |
|---|---|---|
| 6.write | `scripts/test-files.mjs` | `src/server/workspace-files.ts` (`writeFileAtomic`), `src/app/api/workspace/files/route.ts` (`op=write`), `src/app/api/workspaces/[id]/files/route.ts` (`op=write`), `src/lib/fs-rules.ts` (`CAPS.writeLocal` 5 MB, `CAPS.writeCloud` 4 MB), `src/lib/workspace-fs.ts` (`readExact`, `writeFile`, `WriteConflict`, `sha256Hex`) |
| 6.editor | `src/lib/rich/scene-diff.ts`, `src/components/rich/edit-as-drawing.ts`, `scripts/rich-tests/scene-diff.ts` | `src/components/rich/renderers/excalidraw.tsx` (edit mode), `src/components/file-preview.tsx` (pass `externalBody`, the save pill), `src/components/rich/file-loaders.ts` (register **Edit as drawing**), `src/lib/panel.tsx` (`prefillComposer` mode), `src/components/composer.tsx` (append mode) |
| 6.harness | — | `scripts/ui-harness.mjs`, `docs/TESTING.md` (H5, H8, H11) |
| 6.integrate | `scripts/fixtures/ui/{panel-excalidraw-edit,panel-excalidraw-conflict,chat-mermaid-to-excalidraw}.mjs` | `src/server/engine/prompt.ts`, `package.json` (`test:files`), `docs/ROADMAP.md`, `docs/CAPABILITIES.md` (§6.3 "read/write") |

**Dependencies:** `@excalidraw/mermaid-to-excalidraw@2.2.2` (shares `mermaid@11.17.2`), installed by 2a.deps.

**The write op, both modes:** `POST ?op=write&path=<rel>&expect=<sha256 hex>` (local also `&workspace=<abs>`), raw body.

- **Local:** `cleanRel`; `resolveInWorkspace` (realpath inside the workspace); the target must exist and be a regular file per `lstat` (404 missing, 400 folder or symlink); body ≤ 5 MB (413); `sha256(current bytes) === expect`, else 409 `{ error: "changed", sha256 }`. Write `.<name>.syrup-write` (unlink a stale one, flag `wx`), fsync, `rename` over the target; on Windows retry `EPERM`/`EBUSY` 3 times (100, 300, 900 ms), then 423 "file is busy". Returns `{ path, sha256, size }`.
- **Cloud:** owner and a running sandbox (`workspaceFiles`; asleep → 409 `{ error: "not running" }`); `resolve()`; `sb.fs.realpath(target)` must equal the cleaned absolute path (refuses symlinks); `sb.fs.stat` is a file; body ≤ 4 MB; `sb.readFileToBuffer` for the hash; `sb.writeFiles([{ path: temp, content }])`, then `sb.fs.rename(temp, target)`. A tiny window against concurrent agent writes is accepted.
- **New files never go through `write`:** they use the existing `upload` op (free name, never overwrites).

```ts
// src/server/workspace-files.ts
export function writeFileAtomic(workspace: string, rel: string | null, body: Uint8Array, expect: string): Promise<{ path: string; sha256: string; size: number }>   // FilesError 400 | 404 | 409 | 413 | 423
// src/lib/workspace-fs.ts
export class WriteConflict extends FsError { constructor(readonly current: string) { super("changed") } }
export function readExact(t: Target, rel: string): Promise<{ bytes: Uint8Array; sha256: string }>   // op=raw in both modes (cloud ≤ 4 MB)
export function writeFile(t: Target, rel: string, bytes: Uint8Array, expect: string): Promise<{ sha256: string }>
export function sha256Hex(bytes: Uint8Array): Promise<string>                                         // Web Crypto
// src/lib/rich/scene-diff.ts — pure
export function summarizeSceneChange(before: { elements: unknown[] }, after: { elements: unknown[] }, max?: number): string[]   // "Moved “Webhook”", "Added text “retry”", "Deleted an arrow"; ≤ 5 lines
```

**The editor** (`excalidraw.tsx`, edit mode):

- **Editable** when the origin is a file, the panel has a workspace target, the view isn't read-only, and the file is within the mode's cap; otherwise view mode with a note: `Too big to edit here (over ${fmtBytes(remote ? CAPS.writeCloud : CAPS.writeLocal)}).` (5 MB locally, 4 MB in the cloud).
- **Loads exact bytes** with `readExact`; `lastSha` is their hash; `lastDisk` is the parsed scene.
- **Saves:** an `onChange` counts only when `getSceneVersion(elements)` changes (selection alone doesn't). 1 s after the last change: `serializeAsJSON(elements, appState, files, "local")`; if its hash equals `lastSha`, nothing happens; else `writeFile(expect = lastSha)`. A status pill shows **Saving…**, **Saved**, or the error. Pending work flushes on unmount and on `visibilitychange: hidden`.
- **Agent changes** (the Preview's 900 ms re-read arrives as `externalBody`): `externalBody` is only the signal. In the cloud `read()` returns trimmed text, so its hash would differ from `lastSha` whenever the file ends with whitespace, and our own save's echo would look like an agent change. So call `readExact(target, rel)` and compare that `sha256` with `lastSha`; never hash `externalBody` itself. Equal → our own write, ignore. Editor clean → `const restored = restore(scrubScene(json))`, then `api.addFiles(Object.values(restored.files ?? {}))`, then `api.updateScene({ elements: restored.elements, captureUpdate })`, keeping the viewport (`updateScene` takes no files, so image elements would lose their bytes otherwise). Editor dirty, or a 409 on save → the banner "The agent changed this drawing." with **Load theirs** and **Keep mine** (writes with `expect` = their hash).
- **Errors:** 413 → "Too big to save from here. Download it instead." · network → "Not saved. Retrying…" (one retry after 3 s, then **Save**) · asleep → "Workspace is asleep; reopen it to save."
- **Send to agent:** `prefillComposer("I changed the drawing in `<rel>`. " + summarizeSceneChange(lastDisk, current).join(" "), { mode: "append" })`; on phones `panel.setOpen(false)` first.
- **Composer append mode:** the `syrup:prefill` event carries `{ text, mode }`; append adds the text after a space (or a newline when the draft ends with one) and focuses the end; replace stays the default (GuiNote is unchanged).

**Edit as drawing** (`edit-as-drawing.ts`, registered with `registerBlockAction` for `mermaid`; shown on ready blocks in the live app only):

1. Prefetch `@excalidraw/mermaid-to-excalidraw` on hover or focus.
2. Inside syrup's Mermaid queue: `const { elements, files } = await runWithMermaid((_, config) => parseMermaidToExcalidraw(source, config))`, passing syrup's config (`theme: "base"`, the themeVariables, `securityLevel: "strict"`). The converter calls `mermaid.initialize` with its own merged config (20px font, default theme, `suppressErrorRendering` and `logLevel` reset) and runs its own queue, so outside `runWithMermaid` it would restyle later chat diagrams and race syrup's renders. `runWithMermaid` marks the renderer's "initialized for scheme" state dirty afterwards, so the next chat render calls `initialize` again. Then `serializeAsJSON(convertToExcalidrawElements(elements), {}, files ?? {}, "local")`: non-native diagram types keep their picture in `files`.
3. `upload(target, …)` into `drawings/` as `<slug>.excalidraw` (the slug from the first label, else `diagram`); the op picks a free name.
4. `panel.openFile(path)`. Types the converter can't do natively become one image element; the button's note says "This diagram type converts as a picture."

**Prompt** (append):

```
- The user can edit .excalidraw drawings in the Preview tab. When they say they changed a drawing, read the file again before you continue.
```

**Security:** writes stay inside the workspace (realpath checks), never through symlinks, never over an agent change without the user choosing **Keep mine**; scenes are scrubbed on load and before save; local writes sit behind Round G's guard; cloud writes are owner-only.

**Acceptance**

- **`pnpm test:files`** (a temp-dir workspace): a matching `expect` writes exact bytes (a trailing newline survives); a mismatch gives 409 with the current hash; a folder gives 400; a missing file 404; `../x` is refused; a symlink target is refused (skipped with a note on Windows without symlink rights); over 5 MB gives 413; the temp file is gone afterwards; two concurrent writes with the same `expect` give one success and one 409.
- **`pnpm test:rich`:** `summarizeSceneChange` (move, add, delete, edit text, nothing).
- **Harness** (needs H5, H8, H11):

| Scenario | Steps | Assertions |
|---|---|---|
| `panel-excalidraw-edit` | Open `drawings/board.excalidraw`; click an empty canvas spot; `{press: "Control+A"}`; `{press: "ArrowRight"}` ×10; `{wait: 1500}`; click **Send to agent** | `{requests: "POST /api/workspace/files", query: "op=write", equals: 1}` · `{text: "Saved"}` · `{value: ["textarea", "I changed the drawing in `drawings/board.excalidraw`"]}` · `{value: ["textarea", "Moved"]}` |
| `panel-excalidraw-conflict` | Same file; click the canvas, `Control+A`, `ArrowRight` ×3; `{setFile: ["drawings/board.excalidraw", <the scene with one more rectangle>]}`; `{emit: file.watcher.updated}`; `{wait: 1500}` | `{text: "The agent changed this drawing."}` |
| `chat-mermaid-to-excalidraw` | `chat-rich-fences`'s chat; click **Edit as drawing** on the first diagram; assert the panel; then close the panel and `emit` a new completed assistant message holding a third flowchart, so a chat render runs after the converter; `{ settle: true }` | `{requests: "POST /api/workspace/files", query: "op=upload", min: 1}` · `{visible: "[aria-label='Workspace panel'] figure[data-rich-kind=excalidraw] canvas"}` (before closing) · after: `{count: ".chat-log figure[data-rich-kind=mermaid] svg[aria-roledescription] .nodeLabel", min: 1}` · `{style: [".chat-log figure[data-rich-kind=mermaid] >> nth=-1 >> .nodeLabel >> nth=0", "font-size", "14px"]}` (H11; the converter's config would make it 20px) |

- **Weight:** `--compare` shows initial JS unchanged; `--budgets` still passes for `weight-excalidraw` (the editor adds no chunk beyond view mode); the converter loads on click (≤ 25 KB, not gated).
- **Manual, local then cloud:** the agent writes a `.excalidraw`, the user moves a box, **Send to agent**, and the agent describes the change on its next turn; a cloud conflict shows the banner.

**Done when:** the agent draws a diagram, the user moves a box, the agent describes the change on the next turn, in both modes; the fixtures pass; the gate passes; pushed and deployed.

---

### 3.7 Round 7: structured tools (about 1½ days)

**Scope:** four MCP tools on syrup's MCP server, rendered by tool name: `syrup_show_chart`, `syrup_show_table`, `syrup_show_diagram` and `syrup_ask_form`. The built-in `question` tool keeps working as today.

**Files**

| Package | Add | Change |
|---|---|---|
| 7.tools | `src/server/show-tools.ts`, `src/lib/forms.ts`, `scripts/test-show.mjs` | `src/server/memory/tools.ts` (one call in `buildMemoryServer`); only if a backend family fails Day-1 check 7.tools: `src/server/router/policy.ts`, `scripts/test-router.mjs` |
| 7.ui | `src/components/tool-renderers.tsx`, `src/components/rich/ask-form.tsx` | `src/components/parts.tsx` (`Tool` reads the registry; `TOOL_LABEL` and `TOOL_VERB` move into it), `src/lib/transcript.ts`, `scripts/test-transcript.mjs` |
| 7.integrate | `scripts/fixtures/ui/{chat-show-tools,chat-ask-form}.mjs` | `src/server/engine/prompt.ts`, `package.json` (`test:show`), `docs/TESTING.md`, `docs/ROADMAP.md`, `docs/CAPABILITIES.md` (§10.1 answered) |

**Dependencies:** none (zod and `@modelcontextprotocol/sdk` are already used by `src/server/memory/tools.ts`).

**The tools** (`registerShowTools(server, log)`; zod schemas; a logging wrapper that records `{ tool, ms, ok, bytes }`, never the arguments):

- **Schemas are flat:** only strings, numbers, booleans, string arrays and arrays of string arrays; no unions (`anyOf`), no open records (`additionalProperties`), no `object | string`. Several of the router's free backends (Gemini's OpenAI-compatible endpoint, Groq and Cerebras strict function schemas) reject or mangle such schemas, and MCP tools ride on every request, so one rejection would fail every turn on that backend. Structured payloads travel as JSON text and are parsed on the server.

| Tool | Input | Checks | Output to the model |
|---|---|---|---|
| `show_chart` | `{ title: string ≤ 120, spec: string }` (the Vega-Lite spec as JSON text) | `JSON.parse` (an error names the position); `lintVegaLite` | ok: `Shown to the user: chart “<title>” (<n> rows).` · issues: `isError`, `Not shown: <issues>. Fix the spec and call show_chart again.` |
| `show_table` | `{ title, columns: string[] (1–50), rows: string[][] (1–5,000) }`, each row as long as `columns` | sizes; ≤ 1 MB; ragged rows refused | `Shown to the user: table “<title>” (<n> rows, <m> columns).` |
| `show_diagram` | `{ title, kind?: string (one of "mermaid", "markmap", "svg"; default "mermaid"), source: string (1–50,000) }` (a string enum, not a union) | mermaid: the first non-comment line names a known diagram type; svg: starts with `<svg` | `Shown to the user: diagram “<title>”.` (the browser parses, autofixes and repairs) |
| `ask_form` | `AskForm` (below) | 1–12 fields; unique keys `^[a-z][a-z0-9_]{0,39}$`; select and multiselect need 1–20 options of ≤ 80 characters | `Form “<title>” is on screen (form <id>). The user's answers arrive as their next message. End your turn now.` |

```ts
// src/lib/forms.ts — pure, shared by the server and the UI
export type FormField = { key: string; label: string; type: "text" | "textarea" | "number" | "email" | "url" | "date" | "select" | "multiselect" | "checkbox"; required?: boolean; options?: string[]; placeholder?: string; help?: string; min?: number; max?: number; default?: string }
// default is text in every type: "42" for number, "true" for checkbox, "a, b" for multiselect (split on commas); the UI parses it per type
export type AskForm = { title: string; intro?: string; submitLabel?: string; fields: FormField[] }
export function formIssues(form: AskForm): string[]
export function formId(callID: string): string                             // "f_" + 6 base36 characters of hash(callID)
export function validateAnswers(form: AskForm, values: Record<string, unknown>): Record<string, string>   // key → error
export function formatAnswers(form: AskForm, id: string, values: Record<string, unknown>): string
export function parseAnswers(text: string): { id: string; title: string; values: Record<string, string> } | null
// message format:
// Answers to “Project basics” (form f_k3j2ab):
// - Project name: acme-shop
// - Launch date: 2026-10-20

// src/components/tool-renderers.tsx
export interface ToolRenderer { label: string; verb: string; Body?: ComponentType<{ part: ToolPart; live: boolean; ro: boolean }>; Chips?: ComponentType<{ part: ToolPart; ro: boolean }> }
export const TOOL_RENDERERS: Readonly<Record<string, ToolRenderer>>        // the built-ins move here from parts.tsx
```

**UI**

- **Labels and verbs:** `syrup_show_chart` Chart / Charting; `syrup_show_table` Table / Tabulating; `syrup_show_diagram` Diagram / Drawing; `syrup_ask_form` Form / Asking. `toolSummary` falls back to `input.title`.
- **Bodies render between the row and the collapsible detail,** in the live and the read-only branch.
  - **show_\***: pending or running → the kind's skeleton (`pending` state). Completed with an output starting "Shown to the user" → `RichBlock` from the input (origin `tool`), so a model's invalid call never draws. The source is `spec` for charts, `source` for diagrams, and `toCsv([columns, ...rows])` for tables. Error or another output → no body (the row shows the error, and the model retries).
  - **ask_form:** completed with an output starting "Form “" → the form (lazy `ask-form.tsx`) with labelled native inputs. **Submit** is enabled only while the session is idle ("Wait for the reply to finish") and sends `useEngine().send(sessionID, formatAnswers(…))`. Once a later user message parses as this form's answers, the form shows those values read-only with **Sent** (`[data-answered]`), live and in shares. Read-only views show it disabled.
- **Transcript** (`src/lib/transcript.ts`): `clipForViewer` keeps the input of these four tools up to 64,000 characters (beyond that, today's note). `renderMarkdown` writes `show_chart` as a ```` ```vega-lite ```` fence, `show_diagram` as its kind's fence, `show_table` as a CSV fence, `ask_form` as a bullet list of its fields.

**Prompt** (append):

```
- To show data you computed, call syrup_show_chart, syrup_show_table or syrup_show_diagram instead of pasting a large block; they check your input and tell you what to fix.
- To ask for several typed answers at once (names, dates, choices), call syrup_ask_form, then end your turn: the answers arrive as the user's next message. For a quick choice, the question tool is fine.
```

**Security:** zod at the boundary; visuals go through the same renderers and sanitizers; answers are plain text in a normal user message; tool output to the model is one short sentence with no secrets.

**Acceptance**

- **`pnpm test:show`** (bundles `show-tools.ts` and `forms.ts`; calls the handlers directly): a valid chart gives text; a chart with `data.url` gives `isError`; a spec that isn't JSON gives `isError` naming the position; 5,001 rows and a ragged row are refused; the JSON schema each tool publishes (as the MCP SDK emits it) contains no `anyOf`, `oneOf` and no `additionalProperties` other than `false`; `kind` defaults to mermaid; an unknown diagram header is refused; a form with duplicate keys, a select without options or 13 fields is refused; `formatAnswers` → `parseAnswers` round-trips.
- **`pnpm test:transcript`:** the four tools' inputs survive `clipForViewer` up to 64,000 characters; `renderMarkdown` writes the fences.
- **Harness** (needs H1 and H5):

| Scenario | Content | Assertions |
|---|---|---|
| `chat-show-tools` | Completed `syrup_show_chart`, `syrup_show_table` (12 rows) and `syrup_show_diagram` (mermaid), a running `syrup_show_chart`, an errored `syrup_show_chart` | `{count: "figure[data-rich-kind=vega-lite][data-rich-state=ready]", equals: 1}` · `{count: "figure[data-rich-kind=vega-lite][data-rich-state=pending]", equals: 1}` · `{count: "figure[data-rich-kind=table] tbody tr", equals: 12}` · `{count: "figure[data-rich-kind=mermaid][data-rich-state=ready]", equals: 1}` · `{text: "Chart"}` |
| `chat-ask-form` | A completed `syrup_ask_form` "Project basics" with text, number, select, checkbox and date fields; steps: fill each, click **Submit** | `{requests: "POST /api/oc/session/*/prompt_async", body: "Answers to “Project basics”", equals: 1}`; then `emit` that user message → `{visible: "form[data-form-id] [data-answered]"}` |

- **Bench:** `pnpm bench:agent` "before" on the running server; the founder restarts `pnpm dev` (§6 I4, before the push; MCP tools load only then); `pnpm bench:agent` "after"; both tables in the commit message (four tool schemas add input tokens to every request).
- **Day-1 check 7.tools** (an isolated engine with the four tools registered, pointed at the router; never the dev server's engine): send one short turn per backend family in the catalog (Gemini, Groq, Cerebras, OpenRouter, Mistral, NVIDIA), pinned to one model of that family. Each must answer without a 400. Record any family that fails. Before the push, fix the schema; if that can't work, leave that family out of routing for requests that carry these tools (a `policy.ts` rule plus a `test:router` case, in package 7.tools), and say so in the commit message.
- **Weight:** `--compare` growth ≤ 0.5 KB gz (the label table moves out of `parts.tsx`; bodies and the form are lazy in the core).
- **Manual, local then cloud:** "ask me three questions about my project" yields a form and the answers reach the agent; "chart orders per weekday with show_chart" renders without a fence. Cloud tools arrive with the sidecar at the next sandbox start.

**Done when:** "ask me three questions about my project" yields a form, the answers reach the agent, and a `show_chart` call renders without a fence, in both modes; the gate passes; pushed and deployed.

---

### 3.8 Round 8: the live app preview (about 1½ days)

**Scope:** an app the agent starts (Vite, Next, a static server) shows in the Preview tab in both modes. The element picker is a later round.

**Files**

| Package | Add | Change |
|---|---|---|
| 8.server | `src/app/api/workspaces/[id]/preview/route.ts` | `src/server/engine/sandbox.ts` (`exposePort`, `closePort`, the port reset, the cloud prompt note passed as `syrupEngineConfig`'s `promptSuffix`) |
| 8.ui | `src/lib/ports.ts`, `src/components/rich/{port-chips,live-frame}.tsx`, `scripts/rich-tests/ports.ts` | `src/lib/panel.tsx` (`openLive`), `src/components/rich/block-preview.tsx` (live blocks; "Preview a port…" in the empty Preview), `src/components/tool-renderers.tsx` (`bash.Chips`; lane C owns this file in Round 8 only) |
| 8.harness | — | `scripts/ui-harness.mjs`, `docs/TESTING.md` (H9) |
| 8.integrate | `scripts/fixtures/ui/{chat-live-preview,chat-live-down}.mjs` | `src/server/engine/prompt.ts`, `docs/ROADMAP.md`, `docs/CAPABILITIES.md` (§4.13, §6.5, and a §9 risk row: Sandbox Data Transfer, 20 GB a month on Hobby, then sandbox creation pauses for every user) |

**Dependencies:** none.

**Interfaces**

```ts
// src/lib/ports.ts — pure
export function detectPorts(text: string, exclude: ReadonlySet<number>): number[]
// ANSI stripped first; (https?://)?(localhost|127.0.0.1|0.0.0.0|[::1]):PORT · "listening on (port )?PORT" · "Serving HTTP on … port PORT";
// ports 1024–65535; deduped; at most 2. Excluded locally: the app's port, 4096, 4210, 4211; in the cloud: 4096, 4210.
export const SYRUP_PORTS: (remote: boolean, appPort: number) => ReadonlySet<number>   // the exclusion set above, shared by detection and the manual input
// src/server/engine/sandbox.ts
export type PortStatus = "up" | "down" | "blocked-host" | "asleep"
export function exposePort(userId: string, workspaceId: string, port: number): Promise<{ url: string; status: PortStatus }>
export function closePort(userId: string, workspaceId: string, port: number): Promise<void>   // sb.update without the port; 4096 stays
```

**Detection and chips:** the bash part's `input.command`, its live `state.metadata.output` and its final `output`. A **Preview :5173** chip on the bash row (`TOOL_RENDERERS.bash.Chips`), live and completed, not in read-only views (there the port shows as text). Clicking calls `panel.openLive(port)`. The empty Preview tab has **Preview a port…** (a number input) for servers that never printed a URL.

- **The manual input** goes through the same rules: an integer in 1024–65535, not in `SYRUP_PORTS(remote, appPort)`; otherwise "That port belongs to syrup." (or "Use a port from 1024 to 65535."). Locally, framing 3000 would load the app itself with `allow-scripts allow-same-origin` on its own origin (the sandbox would be void), and 4096 or 4210 would frame the engine or the router. The cloud route refuses the sandbox's interactive port the same way (400 with the same text).

**Cloud:** `POST /api/workspaces/[id]/preview { port }` → `exposePort`; `POST /api/workspaces/[id]/preview { port, close: true }` → `closePort`:

1. The port must be an integer in 1024–65535, not 4096, 4210 or `sb.interactivePort` (declared in `@vercel/sandbox` 3.4 `dist/sandbox.d.ts:397`), else 400 "That port belongs to syrup."
2. `const { sb } = await workspaceFiles(userId, workspaceId)` (owner and running; asleep → 409).
3. **Idempotent, not rate-limited:** if `sb.routes` already has the port, skip the update. Otherwise `current` = `sb.routes` ports without 4096 and `sb.interactivePort`, and `await sb.update({ ports: [4096, ...current.filter((p) => p !== port).slice(-3), port] })`. 4096 always stays first.
4. `url = sb.domain(port)`; a server-side GET with a 3 s timeout reading at most 2 KB: 502 `SANDBOX_NOT_LISTENING` → `down`; 410 → `asleep`; a body with "Blocked request" or "is not allowed" → `blocked-host`; anything else → `up`.
5. The URL goes back to the browser only; logs carry the port and status, never the URL.

**Closing ports (cloud only; Sandbox Data Transfer):** every byte through an exposed port is metered (20 GB a month on Hobby; past it, sandbox creation pauses for every user until the cycle resets), and no per-session byte count is available. So exposure is capped instead:

- The LiveFrame calls `closePort` when it closes (unmount, and `navigator.sendBeacon` on `pagehide`).
- After 15 minutes without a **Reload** or a navigation inside the frame, the LiveFrame closes the port and shows "Preview paused to save data." with **Resume** (which exposes it again).
- An engine restart resets the list anyway (below). PostHog gets `live_preview_opened { mode, status }` only.

**The reset:** in `openWorkspace`, the existing `if (!created) await sb.update({ networkPolicy })` moves to after the health check and before `startEngine`, and becomes one call: `await sb.update(password ? { networkPolicy } : { networkPolicy, ports: [4096] })` (the engine restarts only when `password` is null). So a restarted sidecar and engine never run with a stale egress policy, and every engine session starts with fresh preview URLs; a hot reuse keeps them.

**`LiveFrame`:** a URL bar (`:5173 /path`), **Reload**, **Open in new tab** (`noopener,noreferrer`), the DeviceBar, and an iframe with `sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"`, `referrerpolicy="no-referrer"`, no `allow`, `title="Live preview of :5173"`. `allow-same-origin` is safe only because `vercel.run` is its own site in the cloud, and because of Round G locally.

- **Local:** the URL is `http://localhost:<port>/` (or `127.0.0.1` when the output printed that); liveness is `fetch(url, { mode: "no-cors" })`, which resolves when something listens.
- **States:** probing → "Starting…"; `down` → "Nothing is answering on :5173 yet." with a retry every 2 s for 30 s and **Ask the agent to start it** (prefills "Start the dev server again in the background and print its URL."); `blocked-host` → "Vite refuses this address." with **Fix** (prefills "Add server.allowedHosts: ['.vercel.run'] to the Vite config and restart the dev server."); `asleep` → "The workspace went to sleep."
- **A Next.js dev server looks `up` but never hydrates** in the cloud: Next 16 serves the HTML but refuses dev-only chunks and HMR to origins it doesn't know (`allowedDevOrigins`; no-cors script loads are matched by Referer). Neither the probe nor the parent page can see that (the frame is another site). So in the cloud, when the bash part that printed the port shows Next's banner (`▲ Next.js`) or its command runs `next dev`, the LiveFrame shows a one-line note, "Next.js needs this address allowed, or the page won't respond.", with **Fix** (prefills "Add allowedDevOrigins: [\"*.vercel.run\"] to next.config and restart the dev server.").

**Prompt:** the shared bullet (append):

```
- Start dev servers in the background (for example `npm run dev > dev.log 2>&1 &`), then print the URL line from the log, so the user gets a Preview button for it.
```

Cloud only, passed by `sandbox.ts` `engineConfig` as `syrupEngineConfig(…, { promptSuffix })` (it never writes `agent` itself, so 2b's repair agent and task deny stay): "This workspace runs in a cloud sandbox. The user opens dev servers through an https://*.vercel.run address, so a Vite config needs server.allowedHosts: ['.vercel.run'], and a Next.js dev server needs allowedDevOrigins: [\"*.vercel.run\"] in next.config."

**Security:** the app's origin never proxies agent apps; cloud URLs are public capability URLs while the session runs (about 62-bit subdomains), registered only on demand and closed when unused, never persisted, logged in full, sent to PostHog (`live_preview_opened { mode, status }` only) or shared, and rotated at each engine start. Locally the manual input can't frame syrup's own ports.

**Acceptance**

- **`pnpm test:rich`:** `detectPorts` on at least 20 lines (Vite 5 and 6, Next 15 and 16 `- Local: http://localhost:3000`, CRA, Astro, SvelteKit, http-server, serve, `python -m http.server`, uvicorn, flask, rails, `php -S`, express "listening on port 8080", ANSI-coloured lines) and negatives (a Postgres `:5432` log line, ssh `:22`, external URLs, syrup's own ports); `SYRUP_PORTS` refuses 3000 (as the app port), 4096, 4210 and 4211 locally.
- **Harness** (needs H9):

| Scenario | Content | Assertions |
|---|---|---|
| `chat-live-preview` | `servers: [{ name: "vite", body: "<h1>Hello from Vite</h1>" }]`; a completed bash part whose output holds `VITE v6.3.0  ready in 312 ms` and `➜  Local:   http://localhost:{{port:vite}}/`; step: click `button:has-text('Preview :{{port:vite}}')` | `{frame: "iframe[title^='Live preview']", text: "Hello from Vite"}` · `{visible: "iframe[sandbox*='allow-same-origin']"}` |
| `chat-live-down` | `servers: [{ name: "dead", listen: false }]`; a bash output with `http://localhost:{{port:dead}}/`; step: click the chip | `{text: "Nothing is answering on :"}` · `{visible: "button:has-text('Ask the agent to start it')"}` |

- **Weight:** `--compare` growth ≤ 0.3 KB gz (the chip is lazy with the tool bodies; only `ports.ts` detection may sit in the main chunk); the live frame ≤ 5 KB after load (not gated).
- **Manual:** "make a Vite app and run it" ends with the app in the panel, locally and in the cloud. "Make a Next app and run it" in the cloud ends with a hydrated page (the agent added `allowedDevOrigins`, or **Fix** did). Cloud: `sb.routes` holds 4096 and 5173 and the chat keeps working; closing the preview removes 5173 from `sb.routes`; after a stop and resume the chip leads to "Nothing is answering", and the prefill restarts the server; after an engine restart the old URL answers 410. Locally, **Preview a port…** with 3000 says "That port belongs to syrup."

**Done when:** "make a Vite app and run it" ends with the running app visible in the panel in both modes; the gate passes; pushed and deployed.

---

## 4. Parallel build plan

### 4.1 Lanes

| Lane | Who | Owns (across rounds) |
|---|---|---|
| **A: chat rendering** | agent 1 | `markdown.tsx`, `parts.tsx`, `src/lib/rich/*` (except lane C's and B's files below), `src/components/rich/*` except lane C's files below (the core, `slot`, `cache`, `scheduler`, `sanitize`, `shadow-markup`, `theme-tokens`, `toolbar`, `lightbox`, `types`, the chat renderers `renderers/{mermaid,svg,math,vega,table,markmap}.tsx`, `ask-form.tsx`), `tool-renderers.tsx` (lane C in Round 8), `transcript.ts`, `globals.css`, `scripts/test-rich.mjs` (the runner); `scripts/rich-tests/{fence,math,autofix,cache,grep,tokens,export-dom,repair,vega,csv,markmap}.ts` |
| **B: engine and server** | agent 2 | `local-guard.ts`, `proxy.ts` (the integrator in Round 4), the `/api/oc` route, `use-typewriter.ts`, `session-view.tsx` and `engine-store.tsx` (2a.follow only; the streaming owner's until committed), `opencode.ts`, `repair-prompt.ts`, router files (after Round 1), `sidecar/events.ts`, file routes, `src/server/workspace-files.ts`, `workspace-fs.ts`, `fs-rules.ts`, `show-tools.ts`, `forms.ts`, `memory/tools.ts`, `sandbox.ts`, the preview route; tests `test-guard`, `test-files`, `test-show`, `test-router` |
| **C: panel, files, previews** | agent 3 | `panel.tsx`, `side-panel.tsx`, `composer.tsx`, `file-preview.tsx`, `share-export.ts`, `html-inline.ts`, `boot.ts`, `vendor-assets.mjs`, `preview-shell/**`, `src/server/preview-server.ts`; `src/lib/rich/{sniff,notebook,geojson,excalidraw-safety,excalidraw-assets,scene-diff}.ts`; `src/lib/{preview-protocol,preview-origin,ports}.ts`; `src/components/rich/{file-loaders.ts,block-preview.tsx,edit-as-drawing.ts,device-bar.tsx,port-chips.tsx,live-frame.tsx,preview-frame.tsx}`; `src/components/rich/renderers/{excalidraw,geojson,notebook,preview}.tsx`; tests `test-preview`, `scripts/rich-tests/{files,scene-diff,ports}.ts` |
| **H: harness** | the existing UI-harness agent | `scripts/ui-harness.mjs`, `scripts/fixtures/ui/_kit.mjs`, `scripts/js-weight.mjs`, `scripts/fixtures/js-budgets.json` and `docs/TESTING.md` (in rounds with a harness package; otherwise the integrator: budget rows in Rounds 4 and 5, TESTING lines in Rounds 4 and 7) |
| **I: integrator** | one agent per round (may be lane A's) | `package.json`, `pnpm-lock.yaml`, `src/server/engine/prompt.ts`, `scripts/rich-tests/prompt.ts`, `scripts/fixtures/js-weight-baseline.json`, `src/proxy.ts` in Round 4 only, fixtures under `scripts/fixtures/ui/` (new files and assertion edits), `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/CAPABILITIES.md`, `docs/TESTING.md` (in rounds without a harness package) |

### 4.2 Rules

- **Interfaces first.** On day 1 of Round 2a, lane A lands `kinds.ts`, `types.ts`, `lazy.ts`, `loaders.ts`, `actions.ts` and a stub `core.tsx` exporting §2.15's signatures, so lanes B and C build against stable types.
- **One owner per file per round** (§4.3 lists them). Shared spots use extension points instead of cross-edits: block actions (`registerBlockAction`), loader maps (`CHAT_RENDERERS`, `FILE_RENDERERS`), tool renderers (`TOOL_RENDERERS`).
- **Work ahead in a worktree.** A package of a later round is built in `git worktree add ../syrup-<package> -b rich/<package>` and merged into the main checkout only at its round's integration. The main checkout holds only the current round's files, so every round's commit passes the gate on its own.
  - A worktree has no `node_modules`, and installing is banned outside 2a.deps. Link the main one: `cmd /c mklink /J node_modules C:\Users\sarib\Downloads\repos\syrup\node_modules` (run inside the worktree folder).
  - In a worktree run only `pnpm typecheck`, `pnpm exec eslint …` and the node unit suites (`test:rich`, `test:router`, …).
  - The harness and `ui:weight` run only in the main checkout (the harness drives the one dev server, which serves the main tree; `ui:weight` runs `next build`, which type-checks the whole tree), and only when `git status --short` lists no file outside the round. Otherwise ask the owners to commit first.
  - If a second server is unavoidable, start it with `next dev -p <free port>` and `SYRUP_ROUTER_PORT`, `OPENCODE_PORT`, `SYRUP_PREVIEW_PORT` (Round 5 on) set to free ports and `SYRUP_DB=file:<scratch path>` (nextjs spike Q5). Never the default ports: a second router on 4210 or engine on 4096 would collide with the founder's dev server.
- **Files with another agent's uncommitted work** are edited only after their owner commits them; until then, hand the change to the owner. On 2026-10-08 (`git status`): `src/app/api/oc/[...path]/route.ts`, `src/lib/engine-store.tsx`, `src/components/{session-view,message,side-panel,parts}.tsx`, `src/lib/use-typewriter.ts`, `scripts/ui-harness.mjs`, `scripts/fixtures/ui/{_kit,chat-streaming,chat-tools}.mjs` (plus new `chat-joined-midstream`, `chat-reload-busy`, `panel-saved-width` fixtures), `scripts/bench-agent.mjs`, `scripts/test-router.mjs`, the router files (`src/server/router/{core,health,policy,sessions}.ts`, `src/server/router-status.ts`, `src/lib/router-{answers,status}.ts`, `src/components/router-progress.tsx`), `docs/ARCHITECTURE.md`, `docs/TESTING.md` (modified since the critique), `docs/MOTION.md`. This list goes stale fast; the `git status --short` rule below is what counts.
- **Every package starts with `git status --short` and stops if any file it owns is listed** (decision 30). It reports which owner it waits for and does nothing to that file.
- **The router files** (`src/server/router/*`, `src/lib/router-*.ts`, `router-progress.tsx`) are untouched until Round 1 is pushed; then only package 2b.server edits them (and 7.tools, only if Day-1 check 7.tools needs a routing rule).
- **Never** stop or restart the dev server, install packages outside package 2a.deps, or print secrets. Engine checks use an isolated engine (the opencode spike's `launch.mjs` recipe).
- **One commit per round,** made by the integrator after the gate passes; the message lists the packages and any bench tables.

### 4.3 Packages

| Id | Round | Lane | Title | Files | Depends on |
|---|---|---|---|---|---|
| G | G | B | Local origin guard | `src/server/local-guard.ts`, `scripts/test-guard.mjs`, `src/proxy.ts`, `src/app/api/oc/[...path]/route.ts` (header helpers only), `package.json` | the redaction change in `route.ts` committed by its owner |
| 2a.deps | 2a | I | Install all dependencies; `test:rich` script | `package.json`, `pnpm-lock.yaml` | G |
| 2a.follow | 2a | B | What the streaming change lacks: typewriter replace, follow after idle, `session.deleted` | `src/lib/use-typewriter.ts`, `src/components/session-view.tsx`, `src/lib/engine-store.tsx` | the streaming change committed by its owner |
| 2a.core | 2a | A | Stub, rich core, Mermaid, SVG, math | §3.2a table | 2a.deps; the streaming change committed (for `parts.tsx`) |
| 2a.panel | 2a | C | Panel blocks, lazy Preview, export | §3.2a table | 2a.core (interfaces); the streaming change committed (for `side-panel.tsx`) |
| 2a.harness | 2a | H | H1, H3, H4, H10, W1 | §3.2a table | the streaming change committed (for `ui-harness.mjs`, `_kit.mjs`) |
| 2a.integrate | 2a | I | Prompt, fixtures, docs, push | §3.2a table | 2a.follow, 2a.core, 2a.panel, 2a.harness |
| 2b.server | 2b | B | Repair agent, router leash, sidecar filter | §3.2b table | Round 1 pushed, 2a.integrate |
| 2b.client | 2b | A | Repair client and write-back | §3.2b table | 2a.integrate |
| 2b.harness | 2b | H | H2 | §3.2b table | 2a.harness |
| 2b.integrate | 2b | I | Fixtures, docs, bench, push | §3.2b table | 2b.server, 2b.client, 2b.harness |
| 3.renderers | 3 | A | Vega, table, markmap | §3.3 table | 2a.integrate (pushes after 2b unless Round 1 is late, §3.3) |
| 3.harness | 3 | H | W2 | §3.3 table | 2a.harness |
| 3.integrate | 3 | I | Prompt, fixtures, docs, push | §3.3 table | 3.renderers, 3.harness |
| 4.files | 4 | C | File kinds in Preview | §3.4 table | 3.integrate |
| 4.integrate | 4 | I | Scripts, prompt, fixtures, docs, push | §3.4 table | 4.files |
| 5.shell | 5 | C | Shell, local listener, protocol | §3.5 table | G, 4.integrate |
| 5.frame | 5 | C | PreviewFrame and entry points | §3.5 table | 5.shell |
| 5.harness | 5 | H | H6, H7 | §3.5 table | 2a.harness |
| 5.integrate | 5 | I | Prompt, fixtures, deploy the shell, push | §3.5 table | 5.frame, 5.harness |
| 6.write | 6 | B | `op=write` on both routes | §3.6 table | G |
| 6.editor | 6 | C | Editable Excalidraw, Edit as drawing | §3.6 table | 6.write, 5.integrate |
| 6.harness | 6 | H | H5, H8 | §3.6 table | 2a.harness |
| 6.integrate | 6 | I | Prompt, fixtures, docs, push | §3.6 table | 6.editor, 6.harness |
| 7.tools | 7 | B | MCP show tools and forms | §3.7 table | 3.integrate merged (`vega-lint.ts`); its worktree branches from main after that |
| 7.ui | 7 | A | Tool renderers, form, transcript | §3.7 table | 7.tools (`forms.ts`), 6.integrate |
| 7.integrate | 7 | I | Prompt, fixtures, docs, bench, push | §3.7 table | 7.ui |
| 8.server | 8 | B | Ports on demand, reset, probe | §3.8 table | 7.integrate |
| 8.ui | 8 | C | Detection, chips, LiveFrame | §3.8 table | 7.integrate |
| 8.harness | 8 | H | H9 | §3.8 table | 2a.harness |
| 8.integrate | 8 | I | Prompt, fixtures, docs, push | §3.8 table | 8.server, 8.ui, 8.harness |

**What each round's commit contains:** G = {G}. 2a = {2a.deps, 2a.follow, 2a.core, 2a.panel, 2a.harness, 2a.integrate}. 2b = {2b.server, 2b.client, 2b.harness, 2b.integrate}. 3 = {3.renderers, 3.harness, 3.integrate}. 4 = {4.files, 4.integrate}. 5 = {5.shell, 5.frame, 5.harness, 5.integrate}. 6 = {6.write, 6.editor, 6.harness, 6.integrate}. 7 = {7.tools, 7.ui, 7.integrate}. 8 = {8.server, 8.ui, 8.harness, 8.integrate}.

### 4.4 Integration steps (every round)

1. `git status --short`: no file outside the round may be listed (decision 30). If one is, ask its owner to commit and wait. Rounds 2b and 7 run `pnpm bench:agent` "before" now, on the running server, before anything is merged.
2. Merge the round's package branches into the main checkout in the dependency order of §4.3.
3. The integrator edits the shared files: the prompt bullets (recording the prompt's token delta), `package.json` scripts, fixtures, ROADMAP status and corrections, TESTING (or hands lines to lane H), ARCHITECTURE.
4. Run the gate (§3.0). A failure is fixed inside the owning package's files by that package's lane.
5. **Rounds 2b and 7 only:** ask the founder to restart `pnpm dev` (§6 I4) and wait; then `pnpm bench:agent` "after"; paste both tables into the commit message. A slower median first token blocks the push until explained.
6. Look at every screenshot of the screens the round touched, at both widths and in WebKit.
7. Run `pnpm ui:weight --update` (the gate's `--compare` has passed) and put the before and after initial gzip figures from `--compare`'s output in the commit message; the new `js-weight-baseline.json` goes into this round's commit, so the next round's 2 KB allowance starts from here. Commit once and push; watch the Vercel deploy.
8. Do the round's infrastructure steps (§6). Exception: Round 5's I1 and I2 run before its push (step 7), because the app's build reads the preview origin.
9. Every round from 2a except 2b and 7: ask the founder for a `pnpm dev` restart (§6 I4). Then run the round's manual live checks.

### 4.5 Calendar (three code lanes, the harness agent, an integrator)

| Day | A | B | C | H | Pushes |
|---|---|---|---|---|---|
| 1 | interfaces (new files only); 2a.core once the streaming change is committed | G once the redaction change is committed; 2a.follow once the streaming change is committed | 2a.panel (new files first) | 2a.harness once the streaming change is committed | **G** |
| 2 | 2a.core | 2b.server once Round 1 is pushed | 2a.panel | 2b.harness | **2a** |
| 3 | 2b.client; 3.renderers (worktree) | 2b.server; 6.write (worktree) | 4.files (worktree) | 3.harness | **2b** |
| 4 | 3.renderers | 7.tools (worktree, branched from main after 3.integrate merges, afternoon) | 4.files; 5.shell (worktree) | 5.harness | **3**, **4** |
| 5 | — | 7.tools | 5.shell, 5.frame | 6.harness | **5** |
| 6 | 7.ui | 8.server (worktree) | 6.editor | 8.harness | **6** |
| 7 | 7.ui | 8.server | 8.ui (worktree) | — | **7** |
| 8 | — | — | 8.ui | — | **8** |

About 14 agent-days; 8 working days of pushes, counted from the day both foreign changes (redaction, streaming) are committed. If either slips, the calendar slips with it; lane A's new files and lane C's new files can still start.

---

## 5. Harness and weight extensions

Owner: the UI-harness agent (lane H). Each lands in the round's harness package before that round's fixtures need it.

| Id | Extension | Round |
|---|---|---|
| H1 | Assertion `{ requests: "<METHOD> <path glob>", query?: substring, body?: substring, equals \| min \| max }` over every `/api/**` request the page made (method, path, search and body text recorded) | 2a |
| H2 | Repair mocks: `GET /api/oc/agent` → `engine.agents` (default build, plan, general, explore, and `repair` as a hidden subagent); `POST /api/oc/session` keeps `parentID` and `title`; `POST /api/oc/session/:id/message` → `{ info, parts: [{ type: "text", text }] }` from the first `engine.replies[i]` whose `match` occurs in the request text (else the request's first fence echoed); `PATCH /api/oc/session/:sid/message/:mid/part/:pid` → ids checked, the part replaced in the page's copy, `message.part.updated` pushed on the stream | 2b |
| H3 | Assertion `{ external: N }`: the count of blocked third-party requests | 2a |
| H4 | Export: `GET /api/shares/export?format=bundle` → `{ transcript }` built from the scenario's chat with `buildTranscript` (bundled with esbuild like `test-transcript.mjs`); step `{ download: selector, save: name }`; assertion `{ file: name, contains: [...], notContains: [...] }`; step `{ openFile: name, javaScript: false }`, after which assertions run on that page and it is screenshotted as `<scenario>-<width>-file.png` | 2a |
| H5 | Assertion `{ value: [selector, substring] }` for inputs and textareas | 6 |
| H6 | Frames: assertion `{ frame: iframeSelector, text \| visible \| count, equals \| min \| max }`; step `{ frameClick: [iframeSelector, innerSelector] }` | 5 |
| H7 | The preview origin: `http://127.0.0.1:4211/` answered from `preview-shell/index.html` with `previewHeaders(true)`; per-scenario `allowExternal: ["https://esm.sh"]` with record and replay under `node_modules/.cache/ui-harness/esm/` (first run records with network); console messages from preview-origin frames are notes, not failures | 5 |
| H8 | File writes: `POST /api/workspace/files?op=write` (the `expect` check; 409 `{ error: "changed", sha256 }`; otherwise `files` updated, `{ path, sha256, size }` returned); `op=upload` (single chunk, a free name, added to `files`); step `{ setFile: [path, content] }` | 6 |
| H9 | `servers: [{ name, body?, listen?: false }]`: real HTTP servers on free ports (or a reserved port with nothing listening), `{{port:<name>}}` substituted in fixture text and selectors, their origins not blocked, their frames' console messages notes | 8 |
| H10 | Waiting for renders: after the panel opens and after a scenario's last step, wait until no `[aria-busy]` exists in `.chat-log` or `[aria-label='Workspace panel']` and no `figure[data-rich-state=loading]` exists, with a 60 s timeout (a first dev compile of Mermaid can be slow), then `settle`. Today `aria-busy` is awaited only at page load, and `waitForStable` compares `document.body` text length and element count, which ignore shadow-root content, so a chunk compiling for over 600 ms reads as stable. Documented in TESTING §3.4. Needed by `chat-rich-streaming-close`, `chat-rich-zoom`, `panel-preview-kinds` and `chat-mermaid-to-excalidraw` | 2a |
| H11 | Assertion `{ style: [selector, cssProperty, expected] }`: the computed value of the first visible match | 6 |
| W1 | `pnpm ui:weight --budgets`: `scripts/fixtures/js-budgets.json` maps a scenario to the most after-load gzip bytes (JS + CSS) it may add beyond `chat-markdown`'s after-load; panel scenarios run their `panel` step first | 2a |
| W2 | `pnpm ui:weight --perf`: on the production build, a CDP trace (`devtools.timeline`) per listed scenario at 1440 px (1× CPU) and 390 px (4× CPU via `Emulation.setCPUThrottlingRate`); prints the longest main-thread task; fails when 1440 px exceeds 300 ms | 3 |

---

## 6. Infrastructure steps

| Id | Round | Owner | Step |
|---|---|---|---|
| I1 | 5 | **Claude, after the founder's yes to §0 question 1** | Create and deploy the preview project from the repo root: `vercel project add syrup-preview`, then `vercel link --yes --project syrup-preview --cwd preview-shell`, then `vercel deploy --prod --yes --cwd preview-shell`. Vercel names the production domain after the project (`syrup-preview.vercel.app`, which answers 404 today and is very likely free). Verify: `curl -sI https://syrup-preview.vercel.app/` gives 200 with the CSP and no `Set-Cookie`; `curl -sI https://syrup-preview.vercel.app/x` gives 404; neither redirects to Vercel's SSO (Standard Protection exempts production domains). Run the commands in the scope that holds `syrup` (`syedsaribsultans-projects`; add `--scope syedsaribsultans-projects` if `vercel whoami` shows another). The project is not Git-connected on purpose: deploys happen by I3. `.vercel/` inside `preview-shell/` is already ignored by `.gitignore` (the pattern `.vercel` matches any folder) |
| I1b | 5 | **Founder, only if I1's curl shows a 302 or 401 to `vercel.com/sso-api`** | In the Vercel dashboard: project `syrup-preview` → Settings → Deployment Protection → Vercel Authentication → **Standard Protection** (not "All Deployments"), Save. Then Claude reruns I1's two curl checks |
| I2 | 5 | Claude | Only if Vercel assigned another domain (the name was taken): set it on the app from the repo root with `printf '%s' "https://<assigned>.vercel.app" \| vercel env add NEXT_PUBLIC_SYRUP_PREVIEW_ORIGIN production`. The shell needs no change: it checks the app's origin, not its own. A `NEXT_PUBLIC_` value is read at build time, so run I1 and I2 before Round 5's push; the push's deploy then carries it. The default in `previewOrigin()` covers the expected name, so normally nothing is set |
| I3 | 5 onward | Claude | After any change under `preview-shell/`, redeploy with `vercel deploy --prod --yes --cwd preview-shell` in the same push; the protocol's `v` covers version skew |
| I4 | 2a–8 | **Founder** | Restart `pnpm dev`. **Rounds 2b and 7: before the push**, between the two bench runs (§4.4 step 5): the router's repair code (the router listener starts once at boot), the repair agent and the MCP tools load only after a restart, and the "after" bench must measure them. **Every other round from 2a: after the push**, before its manual live checks (every round edits `prompt.ts`; Round 5 also starts the preview listener on 4211). Claude never restarts the dev server. Running sandboxes pick the change up at their next engine start; nothing to do in the cloud |
| I5 | 4 | Claude | None beyond checking the deploy: Vercel runs `pnpm build`, which now runs `vendor-assets` first; confirm a signed-out `curl -sI https://syrup.syedsarib.com/vendor/maplibre/maplibre-gl-worker.mjs` answers 200 (not a 307 to `/signin`; 4.integrate added `/vendor/` to `PUBLIC`) |
| I6 | 8 | Claude | Nothing to set up: the app adds and closes sandbox ports at runtime. For the first week after the push, check Sandbox Data Transfer on the Vercel usage page (`vercel usage` if available, else ask the founder for a screenshot) against the 20 GB Hobby allowance |

---

## 7. Open questions

1. **May Claude create the `syrup-preview` Vercel project?** (§0.) Blocks only Round 5's cloud acceptance (I1). Nothing else in this plan waits on an answer.

**Critique points not taken as written** (2026-10-08; everything else from the critique is in the text above):

- **Live preview rate limit (§3.8):** the critique offered a `previewUpdatedAt` column on the sandboxes row with a 429 inside 2 s, as the alternative to idempotence. Not taken: it needs a schema migration, and an idempotent `exposePort` (skip when `sb.routes` has the port) already removes the repeated updates. The route is owner-only, so the remaining risk is one user racing their own clicks, which `sb.update`'s replace-the-list semantics tolerate.
- **Next.js note in the LiveFrame (§3.8):** the critique asked for a console note. The parent can't read a cross-site frame's console, so the note is triggered by Next's banner or a `next dev` command in the bash part that printed the port. Same text and **Fix** prefill.
- **Day-1 check 7.tools "leave it out":** read as "fix the schema first; only if that fails, keep that backend family out of routing for requests carrying these tools", so no family is dropped from ordinary turns.
- **Bench in an isolated `next start` (§3.0):** not chosen, as the critique itself preferred: it needs provider keys, which `js-weight`'s isolation removes. The founder's restart before the push is used instead.
- **Waiting for the streaming change** may push Round 2a's start. The calendar (§4.5) counts from the day it and the redaction change are committed; no package works around them.

---

## 8. Changes to ROADMAP.md and CAPABILITIES.md

The integrator of each round applies that round's lines when it pushes.

| Round | Where | ROADMAP or CAPABILITIES says | Becomes | Why |
|---|---|---|---|---|
| G | ROADMAP §3 | (no round) | A Round G row before Round 2 in §6's status table | The live-verified local read hole, and DNS-rebinding reads of `/c/<id>` pages |
| 2a | ROADMAP §2 | "Every renderer is a `next/dynamic` chunk" | "Every renderer is a lazy `import()` chunk loaded on first use and prefetched on idle; panel-only views may use `next/dynamic`" | Decision 3 |
| 2a | ROADMAP R2 | "the main chunk size is unchanged (check `next build` output)" | "`pnpm ui:weight --compare` passes" | Next 16 no longer prints sizes |
| 2a | ROADMAP R2 | `$ … $` → KaTeX | Add: with the Pandoc dollar guard; `\(…\)` and `\[…\]` normalized | `$5 and $10` would become math |
| 2a | ROADMAP R2 | (not listed) | Depends on the streaming change (`message.part.delta`, another agent's) being committed | Decision 6 |
| 2a | ROADMAP R2 | "repair loop" in Round 2 | Round 2 is split: 2a fences, 2b repair | ~3 days of work |
| 2b | ROADMAP R2 | "one hidden `syrup/fast` call" | Add: free models only (the title leash); the fix is written back into the chat; automatic for replies that ended in the last 10 minutes, **Try to fix** on older ones | Decisions 16–18: reading history never spends quota |
| 5 | ROADMAP R5 | `sandbox="allow-scripts"` and "a strict CSP" | `sandbox="allow-scripts allow-forms allow-modals"`; the CSP allows scripts and styles from five CDNs, fonts from Google Fonts, images and fetches from esm.sh only, nothing else | Forms never submit without `allow-forms`; agent pages use CDN libraries and Tailwind's CDN (decision 24) |
| 3 | ROADMAP R3 | "validate the spec with the published JSON schema" | "validate with a lint plus Vega's compile and runtime errors" | 142–179 KB, 0.8 s, misses field errors |
| 5 | ROADMAP R5 and §4 | "needs one DNS record" (`preview.syedsarib.com`) | "needs the `syrup-preview` Vercel project" (`syrup-preview.vercel.app`) | A subdomain is the same site (CSRF, cookie tossing) |
| 7 | ROADMAP R7 | "a small OpenCode custom-tool pack … Local: tools in the engine's config dir; cloud: written into the sandbox" and "Spike first" | "four MCP tools on syrup's MCP server, with flat schemas; the spike is done" | A plugin npm-installs into every config dir (21–28 s on the first request) unless each is pre-seeded, the user's own included; no argument validation |
| 8 | ROADMAP R8 | "declare ports `[3000, 5173, 8080, 4173]` at sandbox create (max 4, must be upfront)" and "Local: a loopback proxy route" | "ports on demand with `sb.update` (max 15, 4096 always kept, closed when the preview closes or after 15 idle minutes, reset per engine start); locally the iframe loads the dev server's own address" | Verified limits; a proxy would run agent code on the app's origin; port traffic is metered |
| 8 | CAPABILITIES §9 | (no row) | Risk: Sandbox Data Transfer is 20 GB a month on Hobby; past it, sandbox creation pauses for every user until the cycle resets. Mitigation: ports close when unused | Sandbox spike |
| 4 | CAPABILITIES | Excalidraw "~1 MB+", MapLibre "~210 KB" | 363.5 KB + 21.7 KB CSS; about 421 KB with its worker | Measured |
| 6 | CAPABILITIES §6.3 | "both modes already have workspace-fs read/write" | Writes arrive in Round 6 (`op=write`) | Nothing could overwrite a file |
| 7 | CAPABILITIES §10.1 | Open questions 1 and 2 | Answered by the opencode-tools spike | — |
| 8 | CAPABILITIES §4.13, §6.5 | Ports declared up front; `/api/preview/:port/*` | As Round 8 above | — |
| every | ROADMAP §6 | Status rows | Updated per push | — |

---

## Appendix A. Spike references

Starting points tested with the exact pinned versions in Chromium and WebKit, under `C:\Users\sarib\AppData\Local\Temp\claude\c--Users-sarib-Downloads-repos-syrup\9f657dd4-d8e5-4c9a-885b-599133ccbc6d\scratchpad\research\`:

- **Renderers:** `libs-pnpm\app\r\` — `mermaid.tsx`, `svg.tsx` (DOMPurify hooks and the hostile SVG), `math.tsx`, `math-guard.ts`, `katex.tsx`, `vega.tsx` (theme from CSS variables), `table.tsx` (TanStack v9 API), `markmap.tsx`, `excalidraw.tsx`, `m2e.tsx`, `maplibre.tsx` (worker URL), `ipynb.tsx`.
- **Fence probes:** `spike5\fence-probe.mjs` (the 12 closure cases), `spike5\rm-props.mjs` (what the `pre` and `code` overrides receive), `robust\probe-math.mjs`, `robust\probe-pre.mjs`.
- **OpenCode:** `opencode\launch.mjs` (an isolated engine), `opencode\repair.mjs` (the child-session repair call), `opencode\proof\` (agent list, repair responses, tool parts), `opencode\src\anomalyco-opencode-545f51d\` (source at v1.18.32).
- **Sandbox:** `sandbox\experiment.mjs`, `followup.mjs`, `results.json` (ports, update, resume, URLs).
- **Critique (2026-10-08):** `critique\overlay.mjs` (a `:host` overlay escaping a shadow root, confined by the clip; `image-set()` fetching from a `<style>` rule and a `style` attribute), `critique\run.mjs` with `entry.jsx` (React 19.2.8 `<template shadowrootmode>`: children serialize empty, `dangerouslySetInnerHTML` keeps the SVG).
