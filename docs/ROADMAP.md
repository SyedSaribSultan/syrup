# Roadmap

Status: **agreed 2026-10-07.** Rounds of one to two days, each ending in a stable push to `main` and a production deploy. Decisions below were taken in an interview on 2026-10-07; change them here, not in chat.

Related: [CAPABILITIES.md](CAPABILITIES.md) (research behind rounds 2–8), [MOTION.md](MOTION.md) (the plan behind rounds 9–12), [ARCHITECTURE.md](ARCHITECTURE.md) (what exists).

## 1. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | First track | **Capabilities** (what the agent can show and make beyond text), then router follow-ups, then motion |
| 2 | Round size | **Small: 1–2 days each**, every round ends in a push |
| 3 | First users | **Everyone equally**: generic layers (fences, files) before domain-specific tools |
| 4 | Warm-up mini-game | **Keep as shipped**; read PostHog (`warmup_*`) after two weeks, then decide |
| 5 | Capability layers in scope | **L0 fences, L1 files in Preview, L2 structured tools, L3 live app preview** |
| 6 | Editable canvases | **Excalidraw embedded, editable**; no own vector editor yet |
| 7 | Agent-written HTML/React previews | **Separate origin** (a preview domain), never the app's origin |
| 8 | Broken Mermaid/Vega from weak models | **Auto-repair once, silently** (one hidden Fast call), else show the source |
| 9 | Overlay motion (menus, sheets, dialogs) | **Yes, quick feel: 120 / 180 / 240 ms** |
| 10 | Sidebar ↔ rail | **Animate**, with the plain-swap fallback |
| 11 | Route transitions | **Later, own phase** (M4) |
| 12 | Tabs and inline error lines | **Colour only; errors instant** |
| 13 | Hard turns (plan/debug/design) | **Answer fast, escalate after**: fastest adequate model first, stronger model on the next turn if needed; hedged like opening turns |
| 14 | Groq key | **Later**; nothing changes until it exists, then the scoring prefers it on its own |
| 15 | Hedge quota | **Opening turns only, free non-scarce models** (as shipped) |
| 16 | Fast alias (titles, tiny calls) | **4 s deadline, then skip**: a title is optional |
| 17 | Cloud launch leftovers (exports, headers, status page, iPhone check) | **Not in this plan** |
| 18 | The founder's own problem list | **Handed over later, separately**; the plan stands until then |
| 19 | Quality bar per push | **Typecheck, lint, suites, Playwright screenshots at 390 px and 1440 px** |
| 20 | Where the plan lives | **This file** |

## 2. Rules for every round

- **Ends in a push.** Typecheck, lint (no errors in `src`, `scripts`, `sidecar`), `pnpm test:router`, `pnpm test:diffs`, `pnpm test:transcript`, Playwright screenshots at 390 px and 1440 px of every screen the round touched, then push and watch the deploy.
- **Local and cloud render the same.** Only the backend may differ.
- **Nothing new in the main chunk.** Every renderer is a lazy `import()` chunk loaded on first use and prefetched on idle; panel-only views may use `next/dynamic`. Heavy libraries (Mermaid, Excalidraw, Vega) load in the panel or on first use, never on page load.
- **First token first.** No round may make the chat's first token later. `pnpm bench:agent` before and after a router change.
- **A fence renders when it closes.** While it streams, a skeleton of the right shape; the typewriter never fights a chart.
- **Phones get a static picture in the chat and the interactive version in the panel.**
- **Agent-written code never runs in the app's origin** (decision 7).

## 3. Rounds

Effort is a guess; a round that runs long is split, not stretched.

### Round 1 — Router follow-ups (½–1 day)

What: the two speed decisions left from today.
- **Hard turns answer fast, escalate after** (decision 13). In `policy.ts`: a hard opening turn uses the opening speed pick and hedge; stickiness releases to a stronger grade on the next user turn ("escalated"), as it already does for hard continuations. The first reply appears in a second or two; the plan or debugging continues on the strong model.
- **Fast alias leash** (decision 16). Requests on `syrup/fast` whose prompt is small (title-sized, under ~4K tokens, no tools) get a 4 s first-token deadline and **no fallback**: a fast, clean error. Verify first how OpenCode treats a failed title call (expected: keeps the default title; confirm in `session/prompt.ts` and the log, fix if it retries noisily).
  - *As built (2026-10-08):* the chat title is OpenCode's only small-model call, recognised by its two fixed texts rather than by size (chats on Fast send small tool-less main turns too). A let-go title is answered with a title made from the user's first message, because OpenCode never regenerates a title and would keep "New session - <timestamp>" forever.
- Bench before and after; the "plan" prompt is the one to watch.

Done when: `pnpm bench:agent` shows the hard turn's first visible output under 5 s on a normal day, titles never hold a turn, 52+ router scenarios pass.

### Round 2 — Rich fences, part 1: Mermaid, SVG, math (1–2 days)

Round 2 is split: **2a** fences, **2b** the repair loop ([RENDERING.md](RENDERING.md) §3.2a, §3.2b). 2a depends on the streaming change (`message.part.delta`) being committed.

What: the markdown renderer (`src/components/markdown.tsx`) turns closed fences into visuals.
- ` ```mermaid ` → Mermaid 11, lazy chunk, rendered to SVG, hash-cached, zoom on click (panel).
- ` ```svg ` → inline sanitized SVG (DOMPurify, no scripts, no external refs).
- `$$ … $$` and `$ … $` → KaTeX, with the Pandoc dollar guard; `\(…\)` and `\[…\]` normalized.
- **Repair loop** (decision 8; Round 2b): `mermaid.parse` on close; on error, one hidden `syrup/fast` call ("fix this Mermaid, return only the block"); on a second error, show the source with a copy button and a one-line note.
- Phones: the SVG scales to the column; tap opens it in the panel.
- Agent side: one paragraph in `prompt.ts` saying these fences render, so models use them.

Done when: screenshots at both widths show a flowchart, a sequence diagram, inline math and an SVG; a deliberately broken diagram is repaired or shown as source; `pnpm ui:weight --compare` passes.

### Round 3 — Rich fences, part 2: charts and tables (1–2 days)

What:
- ` ```vega-lite ` → Vega-Lite (lazy; validate the spec with the published JSON schema before rendering; same repair loop). Theme follows the app's colours.
- ` ```csv ` and ` ```json ` (array of objects) → a real table: TanStack Table, sortable, virtualized past 200 rows, copy as CSV. Markdown tables past ~8 columns get the same treatment.
- ` ```markmap ` → mind map (small, cheap).
- Prompt paragraph extended.

Done when: a bar chart, a line chart and a 1,000-row table render inside the chat at both widths without jank; sorting works on a phone.

### Round 4 — Files in the Preview tab (1 day)

What: extend `file-preview.tsx`'s kind table so files the agent writes render where they live.
- `.mmd` (Mermaid), `.vl.json` (Vega-Lite), `.excalidraw` (view), `.geojson` (MapLibre, lazy, view), `.ipynb` (static cells: markdown, code, outputs), `.svg` as real SVG (sanitized) instead of `<img>`.
- The Preview reloads when the agent changes the file (already does).

Done when: each kind has a fixture in a scratch workspace and a screenshot; the Files tab opens them in one tap.

### Round 5 — Separate-origin HTML/React preview (1–2 days) · **needs one DNS record**

What: agent-written single-file HTML/React runs on a preview origin, never the app's.
- A tiny preview route served on a second hostname (decision 7); the app embeds it in an iframe with `sandbox="allow-scripts"` and a strict CSP; the document arrives by `postMessage`, never by URL.
- Import map to esm.sh for React and a short allow-list of libraries (the Artifacts list: recharts, lucide-react, d3, three, papaparse, mathjs, lodash).
- Device-width switcher in the panel (390 / 768 / 1280). Console errors forwarded into a collapsible strip.
- Local mode: the same page served by the local server on a second port, so the origin is still separate.

Done when: a React counter and a Recharts chart the agent wrote run in the preview on both widths; a page that tries to read `document.cookie` of the app gets nothing.

### Round 6 — Excalidraw, editable, round-trip (1–2 days)

What: `.excalidraw` files open editable in the panel (Excalidraw, MIT, lazy, panel-only).
- Saves back to the file on change (debounced); the agent reads the file on its next turn, which is the round-trip.
- "Send to agent" prefills the composer with "I changed the diagram in `x.excalidraw`; …".
- Mermaid → Excalidraw conversion button on rendered Mermaid blocks (the official converter), so a diagram from Round 2 becomes editable.

Done when: the agent draws a diagram, the user moves a box, the agent describes the change on the next turn.

### Round 7 — Structured tools (2 days)

What: a small OpenCode custom-tool pack, rendered by tool name in `parts.tsx`.
- Spike first (half a day): can a plugin tool set `metadata`/`title` from `execute`, and does `message.part.updated` carry metadata while running? (CAPABILITIES §10.1.) If not, payloads go to `.syrup/artifacts/<id>.json`.
- `ask_form` (fields → the user answers in the chat → the answers go back as the next message), `show_table`, `show_chart`, `show_diagram`. Short text output to the model; the payload to the UI.
- Local: tools in the engine's config dir; cloud: written into the sandbox at start next to skills.

Done when: "ask me three questions about my project" yields a form, the answers reach the agent, and a `show_chart` call renders without a fence.

### Round 8 — Live app preview (2 days)

What: an app the agent starts (Vite, Next, a static server) shows in the Preview tab.
- Cloud: declare ports `[3000, 5173, 8080, 4173]` at sandbox create (max 4, must be upfront; verify they survive snapshot resume), `sandbox.domain(port)`. Local: a loopback proxy route.
- Port detection from the agent's shell output (`localhost:PORT` patterns) with a "Preview" chip on the tool row.
- Device widths as in Round 5. Element picker that prefills the composer is a later round.

Done when: "make a Vite app and run it" ends with the running app visible in the panel in both modes.

### Rounds 9–12 — Motion M0–M3 (1–2 days each)

From [MOTION.md](MOTION.md) with decisions 9–12 applied:
- **R9 / M0:** tokens (`:root` + `src/lib/motion.ts`), Tailwind defaults, reduced-motion base, `check-motion.mjs` in lint, the three raw timings migrated, `loading.tsx` → `.skel`.
- **R10 / M1:** `usePresence`; Dialog, Sheet, Popover with `side`; model picker, PointerMenu and the Logs viewer onto the system; `Notice` for toasts.
- **R11 / M2:** `<Collapse>` for every expand/collapse except the exemptions; `Notice` for banners.
- **R12 / M3:** in-place crossfades, Changes drill-in, panel layer and pane resize, sidebar ↔ rail with the fallback.
- **M4 route transitions and M5 gestures: later** (decision 11).

Done when: everything in MOTION.md §2.2–§2.8 moves as §5 says, §2.9 stays instant, `check-motion.mjs` passes.

## 4. Needs the founder

- **Before Round 5:** one DNS record for the preview origin (a `CNAME` such as `preview.syedsarib.com` → Vercel), plus adding the domain to the Vercel project. Nothing else in the plan waits on it.
- **Whenever:** a Groq key under Providers (decision 14).
- **Later:** the problem list (decision 18); it may reorder rounds 2–8.

## 5. Not in this plan

User data export, WAF/CSP/status page, legal review, real-iPhone keyboard check (decision 17); route transitions and gestures (M4, M5); an own vector editor; D2, Graphviz, 3D, notebooks that execute, DuckDB/Pyodide in the browser. All remain in CAPABILITIES.md for a later plan.

## 6. Status

| Round | State |
|---|---|
| 0 UI harness and initial-JS gate (added) | **done** 2026-10-08 (`e64efc4`) |
| 1 Router follow-ups | **done** 2026-10-08 (`b76741d`): 83 router scenarios; live bench: routine first token 1.0–2.3 s, titles under 1.5 s or a fallback at 4 s |
| 1b Live streaming, state after reload, secrets out of the browser, pane width (added; found by the harness) | **done** 2026-10-08 (`0ebd5e1`) |
| G Local origin guard + credential folders on `/api/workspace/files` (from RENDERING.md) | **done** 2026-10-08 (`bb04c0a`) |
| K Cloud keys out of the sandbox (added; founder's decision) | **done** 2026-10-08 (`402fba7`); verified live: no key in any sandbox process |
| 9 Motion M0 | **done** (`1fecd1c`, merged in `166d4d7`) |
| 10 Motion M1 | **done** (`dd61233`, merged in `166d4d7`) |
| Q Answer quality (added; [QUALITY.md](QUALITY.md)) | Q0, Q1, Q2, Q5 **done** 2026-10-08; Q3 **done** 2026-10-11 (`syrup_calc`, the Numbers rule, the numbers note; K2 sums 5/5 per routed model); next Q4 → Q6, Q1b |
| 2a Rich fences: Mermaid, SVG, math, the export ([RENDERING.md](RENDERING.md) §3.2a) | **done** 2026-10-08: Mermaid diagrams, sanitized SVG and KaTeX math in the chat, `/c/` views and the HTML export; tap or click opens the panel at full size; open fences are skeletons; autofix for common Mermaid breaks. Initial JS: chat 353.6 → 350.0 KB, "/" 345.4 → 295.6 KB (Preview tab and Files tree now load on demand). Reviewed independently: agent SVG, Mermaid and math reach no other site and cannot crash the app. Follow-ups: model repair is 2b |
| 2b–8 Capabilities | queued; contract in [RENDERING.md](RENDERING.md) |
| 11–12 Motion M2–M3 | queued (after the capability rounds that touch the same files) |

Follow-ups found on the way:
- **A workspace's first message waits 3–9 s inside OpenCode** while it builds the folder's instance ("booting location services", the skills scan). Prewarming deeper than the session list would hide it.
- **The admin sandbox probe leaves its temporary workspace behind** when a step fails (QUALITY.md Q6).

## 7. Where we stopped (2026-10-08; updated 2026-10-09)

Paused by the founder after Round 2a, to save the week's quota. Everything listed in §6 as done is pushed and live; nothing is half-built. Pick up here, in this order.

**Next rounds (agreed, not started):**
1. **Q3 Numbers: done 2026-10-11** (QUALITY.md "Q3 results"). Left from it: the **Fix numbers** button stays behind a flag until a third blind set measures ≥ 95% precision; first text on a numbers turn is 5–9 s (was ≈ 3 s) because the model calls `syrup_calc` before it writes — a follow-up may hide or shorten that wait.
2. **Q4 Grounding** (§Q4): `webfetch` override, the "When you answer from the web" section, source chips. **Also:** images from other sites in a reply load only after a tap (founder's decision 2026-10-08; today `![x](https://…)` loads at once, a known exfiltration channel found in the Round 2a review). Not a page CSP.
3. **Q6 small fixes, Q1b the judge**, then rounds **2b–8** per [RENDERING.md](RENDERING.md) and Motion **M2–M3** (§6).

**Follow-ups found on the way (not in any round yet):**
- **A workspace's first message waits 3–9 s inside OpenCode** while it builds the folder's instance ("booting location services", the skills scan). Prewarming deeper than the session list would hide it.
- **The admin sandbox probe leaves its temporary workspace behind** when a step fails (QUALITY.md Q6).
- **The answer checker can't yet check totals written in prose** (`src/lib/answer-checks`); currency pairs in a sentence are checked.
- **`SYRUP_NUMERIC_EFFORT`** (QUALITY.md Q5) is off until an A/B shows it helps.
- **Desktop deep link** `?panel=preview&file=…` opens the panel at 1440 px without selecting the file (Round 4).
- **Round 2a deferrals:** prefetching a renderer when the pointer is over **Open**; the libraries of rounds 3, 4 and 6 are installed in their own rounds, not all at once (RENDERING decision 28 changed).
- **Q2's 20-question passage-choice set** (Tier 2) is not built.
- **Round 2a review minors:** the Mermaid guard also refuses ordinary labels such as `A[parse url()]` (limit it to `style`/`classDef`/`linkStyle` lines and `@{…}` shape data); its refusal note reads like a chart message; KaTeX negative-space macros pass the regex but stay clipped by `.rich-tex` (keep its `contain: paint`).
- **Dependency advisories:** fixed 2026-10-09 (Next 16.3.8 for the `next/og` RCE CVE-2026-94545, sharp, MCP SDK, source-map-js, KaTeX). Two left: `braces` (no fixed release yet; lint-only) and `esbuild` under `drizzle-kit` (dev tool only). Re-run `pnpm audit` when resuming.
- **Live checks not yet done for 2a:** ask "draw the checkout flow and give the formula" locally and in the cloud; re-run `pnpm bench:agent --set all`.

**Housekeeping left for the founder:**
- The merged `motion` worktree at `../syrup-motion` and its branch can go (all of it is in `main`). Remove it with `cmd /c "rmdir /s /q ..\syrup-motion"`, then `git worktree prune` and `git branch -d motion`. On Windows, never `git worktree remove --force` a worktree whose `node_modules` is a junction: it follows the junction and deletes the main checkout's files.

**How to resume:** read §6 and this section, then QUALITY.md §Q4. The gate for every push is §2 plus `pnpm ui:weight --compare --budgets`; never run two UI harnesses at once on this machine.
