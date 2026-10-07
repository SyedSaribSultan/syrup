# Testing

Status: **in use from Round 1 (2026-10-07).** How every round in [ROADMAP.md](ROADMAP.md) proves itself before it is pushed: the gate commands, the UI harness (fixture screens at 390 px and 1440 px) and the JavaScript-weight probe.

**Quick start**

1. Keep `pnpm dev` running in another terminal (local mode on `http://127.0.0.1:3000`).
2. `pnpm ui:harness --label my-check` renders every scenario. Screenshots land in `screenshots/harness/my-check/`. Exit 0 means every check passed.
3. `pnpm ui:weight --compare` builds for production. Exit 0 means no new JavaScript joined the initial load.

---

## 1. The per-round gate

Run these in order. Each must exit 0. The UI harness needs the dev server running (`pnpm dev` in another terminal).

```bash
pnpm typecheck
pnpm exec eslint src scripts sidecar
pnpm test:router
pnpm test:diffs
pnpm test:transcript
pnpm ui:harness --label round-2
pnpm ui:weight --compare
```

- **Screenshots:** open `screenshots/harness/<label>/` and look at every screen the round touched, at both widths. A green table is not enough: the harness checks errors, layout and assertions, not taste.
- **Router changes:** also `pnpm bench:agent` before and after (ROADMAP §2, "First token first").
- **Nothing new in the main chunk:** `pnpm ui:weight --compare` fails when initial JavaScript grows by more than 2 KB gzipped or a new chunk joins the initial load (§4).

### 1.1 When a step fails

Other agents share this checkout and its dev server, so a failure is not always yours.

- **Read the message first.** Every failure names its cause and, for the harness, the scenario and width.
- **A type or lint error in a file you didn't touch** (from `typecheck`, `eslint`, or `ui:weight`, whose `next build` type-checks): someone's edit is half-done. Wait, then run again. Don't "fix" their file.
- **The dev server updated the page mid-run** (someone saved a file): the harness runs that scenario again by itself, up to twice, and says so under "Notes". If a failure ends with "dev server: pushed … during this run as well", run again once the edits stop.
- **Run one `pnpm ui:weight` at a time.** Two production builds into the same `.next` collide.

---

## 2. The UI harness

`scripts/ui-harness.mjs` opens fixture scenarios in the running local app and photographs them. Real models are slow and never answer the same way twice, so **the engine is faked in the browser**:

- **Playwright answers the app's API** from the scenario's data: everything under `/api/oc/**`, the router views, the workspace file API and the other local routes a chat screen calls (table in §2.4).
- **The event stream is real and stays open.** The page's `/api/oc/event` request is handed to a small SSE server inside the harness (`route.continue({ url })`, invisible to the page). The client never hits its reconnect loop, and the sidebar dot stays on "Connected to engine". A step can push more events (`emit`).
- **The fake follows OpenCode 1.18.32 wherever the screen can tell.** That covers what the engine stores, what it streams and how its tools title and word their results. It was checked against the running app and the engine's own code (§5).
- **The clock is frozen** at `NOW` in `scripts/fixtures/ui/_kit.mjs` (`page.clock.setFixedTime`), so "2h ago" and "Running… 12s" never drift. Timers still run.
- **The workspace list is seeded** in localStorage (`syrup.workspaces`, `syrup.directory`) before the app boots, so the fixture's folder is the open one.
- **Nothing leaves the browser.** The real engine, the host's file manager (`/api/workspace/reveal`), the folder picker, the log table and PostHog (`/ingest/**`) are never reached. Requests to other origins are blocked and listed.

### 2.1 Running it

```bash
pnpm ui:harness                                     # every scenario at 390 and 1440 → screenshots/harness/latest/
pnpm ui:harness --label round-2                     # → screenshots/harness/round-2/ (the folder is emptied first)
pnpm ui:harness --only chat-tools,new-chat          # some scenarios
pnpm ui:harness --widths 390,820,1440               # other widths: below 1200 px is a touch device
pnpm ui:harness --headed --widths 390               # watch it in a visible browser
pnpm ui:harness --browser webkit --label r2-webkit  # Safari's engine
pnpm ui:harness --list                              # names and what each one shows
pnpm ui:harness --dir ../my-scenarios               # scenarios from another folder (§3, step 3)
```

Other flags: `--base <url>` (default `http://127.0.0.1:3000`, or `UI_HARNESS_BASE`), `--scale 2` (sharper screenshots), `--no-full`, `--cloud-frame` (§2.3).

A full run takes about 45 seconds. The first run after the dev server starts is slower, because routes compile on demand.

### 2.2 What you get

- **`<scenario>-<width>.png`:** the viewport, which is what a user sees. Phones are 390×844 with touch (like `scripts/shots.mjs`). Desktops are 1440×900 with a mouse.
- **`<scenario>-<width>-full.png`:** when the chat or the panel scrolls, the viewport grown to show all of it.
- **`report.json`:** every result below, per scenario and width. It also records how many attempts each needed and any dev-server updates.
- **A table in the terminal** with one row per scenario and width, then the details of every failure. The run **exits 1** when any of these happens:
  - a **console error** (React's development warnings count) or an **uncaught page error**;
  - a **broken layout**: the page wider than the device, the chat column wider than itself, the chat column **squeezed under 280 px**, the panel past the screen, or Send, ⋯, ☰ or ✕ off screen;
  - a request under `/api/` that **no fixture answers** ("unmocked"). Add it to the fake engine rather than letting it reach the real app;
  - a failed **assertion**, or a step that couldn't run;
  - a **known gap that now passes** (§3.3).
- **Exit 2** means it couldn't reach the app at all.
- **A failed run that the dev server disturbed is run again,** up to twice (see §1.1). The harness listens to Next.js's update socket for that page. For example, a save that lands while the page hydrates makes Next.js throw "Router action dispatched before initialization", which says nothing about the screen.
- **Known console errors are listed, not failed.** The Next.js dev-tools badge is hidden in screenshots only; the errors it would show are already in the table. An expected console error is listed under "Notes" instead of failing the run. Today there is one: WebKit saying it ignores the viewport's `interactive-widget` key, which is set on purpose for Android. The list lives in `KNOWN_CONSOLE` in the script, each entry with its reason.

### 2.3 Local and cloud layout

The hosted app puts the shell inside a flex row on `/w/…` pages (`src/components/cloud-frame.tsx`). That is where phone overflow bugs have hidden: an app shell without `min-w-0` grew to the width of the chat's longest line, in the cloud only.

- **Every run checks the layout twice:** in the local layout, then with `<body>` as that flex row. Problems from the second pass read "in the cloud layout: …".
- **`--cloud-frame`** also takes the screenshots in the cloud layout.
- The harness drives local mode only. Cloud API routes (`/api/workspaces/…`, sign-in) are not faked.

### 2.4 How requests are answered

| The page asks for | The harness answers with |
|---|---|
| `GET /api/oc/path` | the scenario's workspace as `directory` and `worktree` |
| `GET /api/oc/project` | one project per workspace folder in the fixture |
| `GET /api/oc/config/providers`, `/api/oc/provider` | `engine.providers`: syrup Auto and Fast, Google (three models), OpenCode Zen |
| `GET /api/oc/session?directory=` | the scenario's sessions in that folder, newest first |
| `GET /api/oc/session/:id`, `PATCH`, `DELETE` | that session (renames and deletes apply to the page's copy) |
| `GET /api/oc/session/:id/message` | `engine.messages[id]`, parts included. A text or reasoning part that is still streaming comes back **empty**, as the engine stores it |
| `GET /api/oc/session/status` | `engine.status` (the client doesn't ask for it today) |
| `POST /api/oc/session`, `…/prompt_async`, `…/abort`, `…/permissions/:id` | a new empty session; accepted; nothing runs |
| `GET /api/oc/permission`, `/api/oc/question` | `engine.permissions`, `engine.questions` |
| `GET /api/oc/event` (SSE, held open) | `server.connected`, then live events: `session.status` for each busy session, each streaming part's text as `message.part.delta` events, `permission.asked`, `question.asked`, `engine.events`. Then a `server.heartbeat` every 10 s, and whatever `emit` steps push |
| `GET /api/oc/file?path=` | a folder listing built from `files`, in the engine's shape |
| `GET /api/oc/file/content` | the file from `files` |
| `GET /api/workspace/files?op=stat\|raw` | size and bytes from `files` (the Preview tab) |
| `GET /api/workspace/home`, `/api/workspace?probe=1` | Home's path; the fixture's folders exist |
| `GET /api/workspace?path=` | the folder picker's listing: the fixture's folders and the folders above them |
| `POST /api/workspace/reveal`, `/api/workspace/pick` | nothing happens on the host |
| `GET /api/router/answers` (`&live=1`) | `engine.answers` (one per finished assistant step, from the kit), plus `engine.attempts` |
| `GET /api/router/status`, `GET /api/providers` | `engine.router`, `engine.keys` (one free Google key) |
| `GET /api/feedback`, `POST /api/logs`, `GET /api/shares` | no ratings; swallowed; no shares |
| `/ingest/**` (PostHog) | `204`, nothing sent |
| anything else under `/api/` | `501`, and the run fails as "unmocked" |

### 2.5 The scenarios

All play in one fictional project, `acme-shop` (`C:\Users\dev\code\acme-shop`), next to Home (`C:\Users\dev\syrup`), with a few earlier chats in the sidebar.

| Scenario | Screen | What it pins down |
|---|---|---|
| `new-chat` | `/` | Heading, composer, "Working in …", sidebar chats, no "no keys" hint |
| `chat-markdown` | a finished chat | Headings, nested and numbered lists, task list, code blocks, GFM table, quote, file links, two very long URLs that must wrap |
| `chat-tools` | a busy chat, scrolled to its end | Reasoning, grep, read, write, a failed edit (red row, its error), the edit that worked, patch ("Edited 2 files"), a test run the engine stopped at its timeout, a passing run, todowrite, a running build, the Changes count |
| `chat-streaming` | a busy chat | The last reply is still streaming and stops inside an unclosed ` ```python ` fence. Its text is a **known gap** today (§3.3) |
| `chat-rich-fences` | a finished chat | Acceptance fixture for Rounds 2–3: two Mermaid diagrams, Vega-Lite, SVG, inline and display math, a 20-row CSV, a markmap. Valid input, so a renderer that fails here has a bug |
| `panel-preview`, `panel-preview-csv` | chat + Preview | `docs/launch-plan.md` rendered as Markdown; `data/orders.csv` as a table |

---

## 3. Adding a scenario

1. **Copy the closest module** in `scripts/fixtures/ui/` to `<name>.mjs` (kebab-case; files starting with `_` are helpers). One module per scenario. A module may export an array for variants, like `panel-preview.mjs`.
2. **Build the data with the kit** (`_kit.mjs`). It produces what OpenCode 1.18.32 returns: ids, step-start and step-finish around every step, tokens, patches with forward-slash paths, each tool's title and output wording, and router answers.

   ```js
   import { abs, backgroundChats, chat, defineScenario, HOUR, readResult, reasoning, text, tool, WORKSPACE_FILES } from "./_kit.mjs"

   const GRID = "export function Grid({ items }) {\n  return items.map((i) => <Card key={i.id} item={i} />)\n}\n"

   const c = chat("Why is the grid slow?", { ago: 2 * HOUR })
   c.user("The product grid stutters on my phone. Why?")
   c.assistant([
     reasoning("Every card re-renders on scroll…", { ms: 2400 }),
     tool("read", { filePath: abs("src/grid.tsx") }, { ...readResult("src/grid.tsx", GRID), ms: 200 }),
     text("Each card subscribes to the whole cart, so one change re-renders all 48 cards."),
   ])

   export default defineScenario({
     name: "chat-grid",
     description: "One line for --list.",
     route: c.route,
     chats: [c, ...backgroundChats()],
     files: WORKSPACE_FILES,
     assert: [{ text: "subscribes to the whole cart" }, { text: "Thought for 2.4s" }],
   })
   ```

3. **Run it alone:** `pnpm ui:harness --only chat-grid`. Open both PNGs. Check they show what you meant, not a skeleton or an empty chat.
   - **Trying something out first?** Put the module in any folder outside the repo, import the kit by its full URL (`import { … } from "file:///C:/…/syrup/scripts/fixtures/ui/_kit.mjs"`), and run `pnpm ui:harness --dir <that folder>`.
4. **Commit the module.** Screenshots stay out of git (`/screenshots/` is ignored). Fixtures and `scripts/fixtures/js-weight-baseline.json` are committed.

### 3.1 The kit

- **Chats:** `chat(title, { ago, directory, model, routed, id })`, then `.user(text, { after, diffs, files })` and `.assistant(parts, { open, routed, ttft, tokens })`.
  - `open: true` means still streaming: no completed time, no step-finish, and the session is busy.
  - `.busy()` marks a session busy without an open message.
- **Text parts:** `text(s, { ms, open })` and `reasoning(s, { ms, open })`. An `open` part is still streaming: it is served empty and its text arrives as `message.part.delta` events (§5).
- **Tool parts:** `tool(name, input, { status, output, error, title, metadata, ms })`, with `status` one of `"completed" | "error" | "running" | "pending"`, in the shapes OpenCode stores:
  - **completed:** gets the engine's own title (the relative path for file tools, the command for bash, the pattern for grep, "N todos" for todowrite) and `metadata.truncated`.
  - **running:** has no title, so the row shows its input. Bash streams `metadata: { output }`.
  - **error:** carries only the message, so a failed file tool shows its absolute path.
  - For an open part, `ms` is how long it has been running ("Running… 12s").
- **Tool results, word for word:** `readResult(rel, content, { offset, limit })` gives a read's `output` and `metadata`. `bashResult(stdout, { exit, timeoutMs })` gives a command's. A command stopped at its timeout **completes** with `exit: null` and the engine's note; it is not an error. A real error example is an edit whose old text didn't match: `"Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."`
- **Other parts:** `patch(files)` and `file({ filename, mime, url })`.
- **Paths:** `abs("src/cart.ts")` as tools receive it, `slashed(…)` as patches spell it, `rel(…)` as tool titles show it.
- **Data:** `WORKSPACE_FILES` (README, sources, `docs/launch-plan.md`, `data/orders.csv`), `SOURCES` (the cart fix before and after), `diff(path, before, after)` for a user message's `summary.diffs` (drives Changes), `backgroundChats()`, `PROVIDERS`, `KEYS`, `ROUTER`, `NOW`, and `SEC` … `DAY`.
- **Raw data:** `defineScenario({ engine: { … } })` takes these fields:
  - `sessions`, `messages`, `status`, `answers`, `attempts`;
  - `permissions` (`{ id, sessionID, permission, patterns, metadata }`);
  - `questions` (`{ id, sessionID, questions: [{ question, header, options }] }`);
  - `events` (sent when the stream connects);
  - `providers`, `keys` and `router`.

### 3.2 Scenario options

- **`panel: { tab, file }`** opens the workspace panel the way a user does: the panel button, Files, the file. Phones get the full-screen layer, desktops the side pane.
- **`steps`** run in order after the screen settles. Selectors are Playwright selectors (CSS, `text=…`, `:has-text()`). Any step or assertion can carry `widths: [390]`.
  - `{ click }`, `{ tap }`, `{ hover }`, `{ fill: [sel, text] }`, `{ type: [sel, text] }`, `{ press: key }` or `{ press: [sel, key] }`
  - `{ waitFor: sel }`, `{ wait: ms }`, `{ scroll: [sel, "top" | "bottom"] }`
  - `{ emit: event | event[] }` pushes engine events into the open stream, in the engine's shape. To finish `chat-streaming`'s turn, emit these in order:
    1. `message.part.updated` with its text part: the full text, now ending in a closing fence, with `time.end` set. That is how the engine ends a streamed part.
    2. `message.updated` with the message's `info` plus `time.completed`.
    3. `session.idle` with the `sessionID`.

    The chat then shows the text, shows Send again and puts the thumbs under the reply. Read the parts from `scenario.engine.messages` after `defineScenario`.
  - **Clicking a tool row:** click its toggle, `div.cursor-pointer:has-text('…') > button[aria-expanded]`. The middle of a row can be its file link, which opens the file instead.
- **`assert`:** `{ visible: sel }`, `{ hidden: sel }`, `{ text: "…" }` (visible text on the page), `{ count: sel, equals | min | max }`. Add `gap: "why"` to make one a known gap (§3.3).
- **`ready`:** extra selectors to wait for before anything else. Chat routes already wait for the messages, `/` for "Working in".
- **Also:** `settleMs`, `widths`, `colorScheme: "dark"`, `reducedMotion: "reduce"`, `model` (the picked model), `panelPrefs`.

### 3.3 Known gaps

An assertion with a `gap` note describes something the app gets wrong today: `{ text: "Save this as", gap: "the client ignores message.part.delta…" }`.

- **It must fail.** Its failure doesn't fail the run. It is listed under "Known gaps" on every run, so it stays in sight.
- **Once it passes, the run fails** with "passes now, so this gap is closed: delete its gap note in …". Delete the note in the same change that fixed the app, so the assertion guards the fix from then on.
- **Use it only for an app gap you can name,** never to quiet a flaky check.
- **Today's only gap:** `chat-streaming`'s reply text. OpenCode 1.18 streams text only as `message.part.delta` events and stores the part empty until it ends, and `src/lib/engine-store.tsx` ignores those events. So a streaming reply shows no text until each part finishes. Round 2's rule ("while a fence streams, a skeleton of the right shape") needs the client to apply deltas first.

### 3.4 Things that look odd but are right

- **The screen settles by itself.** The harness waits until the page's text stops changing, so typewriter animations and lazy renderers finish before the shot.
- **Busy chats are shown as if watched live.** The engine replays nothing when the stream opens, and the client doesn't ask for `/session/status`. So the harness sends a busy session's `session.status` right after connecting, as the engine does when a step starts. Opening such a chat cold in the real app shows it idle (§6).
- **A reader's position is part of the scenario.** Clicks scroll the clicked row into view. `chat-tools` scrolls back to the end afterwards, where someone reading a busy chat is.
- **The clock is frozen for `Date`, not for timers.** Under the frozen clock the page's Resource Timing API returns nothing; measure network with Playwright's events instead (the JS-weight probe does).

---

## 4. Initial JavaScript (`pnpm ui:weight`)

`scripts/js-weight.mjs` checks ROADMAP §2's "nothing new in the main chunk" on a production build.

```bash
pnpm ui:weight --compare     # build, measure "/" and a chat, fail on growth against the baseline
pnpm ui:weight --update      # build, measure, write scripts/fixtures/js-weight-baseline.json
pnpm ui:weight --no-build    # measure the build already in .next
```

- **Initial** means what the server-rendered HTML declares: the main chunk (`rootMainFiles`, shared by every page) plus the route's own chunks. They load on every visit.
- **After load** means chunks fetched after hydration: first use, `next/dynamic`, idle prefetch, `<Link>` prefetch. They are listed for review and never fail the check, because the roadmap allows them.
- **`--compare` fails** when a route's initial JS grows by more than **2 KB gzipped**, or a **new chunk** joins its initial load.
- **Chunks are matched by content, not by name.** Production chunk files are content-hashed (`0-fbgp0jirfhe.js`), so every edit renames them. The probe matches a chunk across builds by the Turbopack module ids inside it, which are deterministic in production builds. It reads them exactly by evaluating the chunk in an empty `vm` context. A chunk that keeps half its modules is the same chunk.
- **If every chunk reads as new at once,** Turbopack has renumbered its module ids (it widens them as the app grows). Judge by the gzip figure, then re-baseline.
- **Pages run on the fixtures.** "/" is `new-chat` and the chat is `chat-markdown` (`--scenarios a,b` to change). The browser's engine is the fixture, so the numbers don't depend on your chats.
- **Re-baseline only on purpose,** with `--update`, and say why in the commit.
- **It takes about 15 seconds** when Turbopack's build cache is warm, longer after a cold start. Run one at a time (§1.1).

As of 2026-10-07 the baseline is about **343 KB gzipped on "/" and 351 KB on a chat**, of which **222 KB is the main chunk**.

### 4.1 Running next to the dev server

- **Next.js 16 builds into `.next` and runs `next dev` from `.next/dev`,** so the two coexist in one folder (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`, "Concurrent dev and build").
  - `next build` keeps `.next/dev`, `.next/cache` and the lock when it cleans.
  - It never runs `instrumentation.ts`.
  - The probe puts `next-env.d.ts` back as it was.
- **The production server is isolated.**
  - It runs on a free port, with its own router port, database and config folder under `node_modules/.cache/syrup-js-weight/`.
  - The separate database also keeps the memory index off the dev engine's `MEMORY.md`.
  - It gets no provider keys from the environment, and its database holds none, so nothing it does can spend a provider's quota.
  - It is stopped when the probe ends. `--keep` leaves it up and prints how to stop it.
  - `build.log`, `server.log` and the last report (`latest.json`) are in the same folder.
- **`OPENCODE_URL` points at the dev server's engine** (`http://127.0.0.1:4096`), so the server attaches instead of spawning a second engine on the same port.
  - Attach mode can't authenticate there: the engine's password is a per-process random secret (`src/server/env.ts`), and every request to the engine carries the caller's own.
  - The probe doesn't need the engine, because the browser's engine is the fixture.

---

## 5. How close the fake engine is

On 2026-10-07 every GET the screens make was compared with the running app (OpenCode 1.18.32), field by field. The tool texts were taken from the engine's own code. The fake copies, on purpose:

- **A streaming text or reasoning part is stored empty.** Its text exists only as `message.part.delta` events until the part ends. Then the engine stores the full text and sends it as `message.part.updated`. The engine's processor writes the part at `text-start` and `text-end` only.
- **The event stream replays nothing.** It sends `server.connected`, then events as they happen, plus a `server.heartbeat` every 10 seconds.
- **Tool states:** a running tool has no title (bash adds `metadata.output` as it runs). A completed one has the engine's title and `metadata.truncated`. An error has only the message.
- **Tool wording:** read output (`<path>…</path>`, `<type>file</type>`, `<content>`, `1: line`, `(End of file - total N lines)` or `(Showing lines 1-3 of 25. Use offset=4 to continue.)`), the bash timeout note, grep's "Found N matches", the edit error, "N todos".
- **Messages:** user `summary.diffs` (one full-context hunk per file), assistant `info` (tokens, `path`, `finish`), step-start / step-finish / patch order, and router answers per finished step. Title calls carry no session id since 2026-10-07, so they aren't in a chat's answers.

It leaves out fields nothing displays yet: edit's `filediff`, grep's match count, read's `display`, and provider variants and cost tiers.

**After an engine upgrade,** check these again before trusting the screens:

1. **Messages:** fetch a real session through the app, for example `curl "http://127.0.0.1:3000/api/oc/session/<id>/message?directory=<folder>"`. Compare its parts with what the kit builds.
2. **Tool wording:** search the engine binary for the texts the kit copies: `End of file - total`, `shell tool terminated command`, `Could not find oldString`, `` todos` ``.
3. **Events:** compare the events the engine defines (`message.part.delta`, `session.status`, `permission.asked`) with the cases `src/lib/engine-store.tsx` handles.

---

## 6. Known limits

- **Chromium by default, WebKit on request.** `--browser webkit` runs Safari's engine (phone layout has differed between engines before). Neither is a real iPhone: the keyboard, safe areas and Safari's toolbars still need a device.
- **Local mode only.** The cloud layout chain is emulated for layout checks (§2.3). Cloud routes and sign-in are not faked.
- **Dev mode.** The harness runs against `pnpm dev`, so it sees development warnings (good) and is slower than production (fine). Dev-server updates mid-run are retried (§2.2).
- **A reload drops state in the real app.** The engine sends no state when the stream opens, and the client reads neither `/session/status` nor `/permission` nor `/question`. After a reload, a busy chat shows Send instead of Stop until its next step starts, and a pending permission or question disappears while the agent waits for it. The harness's busy scenarios show the chat as watched live (§3.4), so they don't catch this.
