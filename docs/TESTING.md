# Testing

Status: **in use from Round 1 (2026-10-07). Round 1b (2026-10-08) added live streaming, reload and pane scenarios, then stream-drop, stale-read, end-of-reply and offline-chunk ones.** How every round in [ROADMAP.md](ROADMAP.md) proves itself before it is pushed: the gate commands, the UI harness (fixture screens at 390 px and 1440 px) and the JavaScript-weight probe.

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
node scripts/check-motion.mjs
pnpm test:router
pnpm test:diffs
pnpm test:transcript
node scripts/fixtures/settled-blocks-check.mjs
pnpm ui:harness --label round-2
pnpm ui:weight --compare
```

- **Motion:** `node scripts/check-motion.mjs` (also part of `pnpm lint`) fails on raw timings and on `src/lib/motion.ts` and `globals.css` disagreeing ([MOTION.md](MOTION.md) §9). It runs its own self-test first (`SELF_TEST` in the script). A new loophole gets a case there, as well as a rule.
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
- **The stream replays nothing, like the engine's.** The page learns a busy session or a pending permission or question by asking (`/session/status`, `/permission`, `/question`), on the first connect and on every reconnect. Events a step emits change what later reads return, so a reload in a step sees what the engine would have stored.
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

Other flags: `--base <url>` (default `http://127.0.0.1:3000`, or `UI_HARNESS_BASE`), `--scale 2` (sharper screenshots), `--no-full`, `--cloud-frame` (§2.3). `UI_HARNESS_TRACE=1` prints how long each step took, to find what makes a scenario slow.

A full run takes about two minutes (the streaming scenarios wait for text to finish typing). The first run after the dev server starts is slower, because routes compile on demand.

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
| `GET /api/oc/session/:id/message` | `engine.messages[id]`, parts included. A text or reasoning part that is still streaming comes back **empty**, as the engine stores it. A `later` part (§3.1) is left out until a step emits its opening update |
| `GET /api/oc/session/status` | the busy sessions in `engine.status` (the client asks on every connect) |
| `POST /api/oc/session`, `…/prompt_async`, `…/abort`, `…/permissions/:id` | a new empty session; accepted; nothing runs. An answered permission or question is no longer pending |
| `GET /api/oc/permission`, `/api/oc/question` | `engine.permissions`, `engine.questions` (the client asks on every connect) |
| `GET /api/oc/event` (SSE, held open) | `server.connected`, then `engine.events` (none by default), a `server.heartbeat` every 10 s, and whatever `emit` steps push. Nothing is replayed: no `session.status` for a busy session, no pending request, no text a streaming part already has |
| `GET /api/oc/file?path=` | a folder listing built from `files`, in the engine's shape |
| `GET /api/oc/file/content` | the file from `files` |
| `GET /api/workspace/files?op=stat\|raw` | size and bytes from `files` (the Preview tab) |
| `GET /api/workspace/home`, `/api/workspace?probe=1` | Home's path; the fixture's folders exist |
| `GET /api/workspace?path=` | the folder picker's listing: the fixture's folders and the folders above them |
| `POST /api/workspace/reveal`, `/api/workspace/pick` | nothing happens on the host |
| `GET /api/router/answers` (`&live=1`) | `engine.answers` (one per finished assistant step, from the kit), plus `engine.attempts`. A routed step that was still streaming gets its answer when a step emits its `message.updated` with `time.completed` (the kit prepares it in `engine.pendingAnswers`), as the router writes its row when the request ends |
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
| `chat-tools` | a busy chat, scrolled to its end | Reasoning, grep, read, write, a failed edit (red row, its error, its path relative to the project like the rows that worked), the edit that worked, patch ("Edited 2 files"), a test run the engine stopped at its timeout, a passing run, todowrite, a running build, the Changes count |
| `chat-streaming` | a busy chat, watched live | The reply starts after the page opened and streams in as `message.part.delta` events. Its text grows on screen (checked mid-stream), a chat switched away from and back to shows it at once, and it stops inside an unclosed ` ```python ` fence |
| `chat-joined-midstream` | a chat opened mid-reply | The streaming part is served empty: "Writing…" while deltas this page can't place arrive, then the whole reply at once when the part ends (no typing out again), then the turn ends |
| `chat-stream-drop` | the stream drops mid-reply | The text the page watched from the first word stays, with "Writing…" under it, during the drop and after the reconnect's re-read. Deltas after the drop wait (the page lost some), and the final update brings the whole reply once |
| `chat-stale-read-end`, `-step`, `-reconnect` | a read older than the stream | A messages read the engine answered before the reply ended (or before a new step started) reaches the page after it: the chat opened again, or a reconnect's re-read. It must not blank the reply, undo its completion or drop the step (`hold` / `release` steps) |
| `chat-stream-end`, `chat-stream-end-bursty` | a long reply ends | The turn ends milliseconds after the last delta, while the typewriter is still behind: with no scroll step, the reply's last line and its thumbs end up above the composer (`inView`). Steady and bursty deltas |
| `chat-streaming-inline-fence` | a reply streaming | A line starting with inline ` ```code``` ` is a paragraph, not a fence: the code block after it (with a blank line inside) stays one block while it streams |
| `chat-streaming-end-keeps` | a reply ending | The part ends while a code block shows "Copied": the text keeps its DOM, so that state (a selection, a sideways scroll) survives |
| `chat-streaming-offline` | the streaming code can't load | The use-typewriter chunk is blocked (`block`): the reply shows as plain text and the chat stays on screen |
| `chat-reload-busy`, `chat-reload-question` | a reload mid-turn | Busy status and the pending permission (or question) come only from the page's reads: Stop and the card show on the first load and again after a reload |
| `panel-saved-width` | chat + Files pane | A pane saved 1100 px wide (on a 1920 px monitor) opened at 1440 px: the chat keeps 440 px on open, after a resize to 1920 and back, and while the edge is dragged. The title keeps room (the token totals step aside while the pane is open). Phones: the full-screen layer |
| `chat-rich-fences` | a finished chat | Acceptance fixture for Rounds 2–3: two Mermaid diagrams, Vega-Lite, SVG, inline and display math, a 20-row CSV, a markmap. Valid input, so a renderer that fails here has a bug |
| `panel-preview`, `panel-preview-csv` | chat + Preview | `docs/launch-plan.md` rendered as Markdown; `data/orders.csv` as a table |
| `motion-tokens` | `/` | Motion M0: bare `transition` runs on the tokens (120 ms, `--ease-move`); the phone drawer is `motion-layer` and takes no taps while closed; sidebar row actions fade in on hover (desktop), and hidden ones are invisible |
| `motion-row-actions-keyboard` | `/`, 1440 px only | Shift+Tab from a row's link skips the row above's hidden Rename/Delete; Tab then reaches them |
| `motion-switcher-actions` | `/` + workspace switcher, 1440 px only | Only the hovered row's actions show; the others are invisible |
| `motion-drawer-open` | `/`, 390 px only | ☰: the drawer takes the focus, and its slide runs on the compositor (Chromium trace) |
| `motion-theme-switch` | `/` + settings menu | System → Dark starts no transition (the one-frame suppression); the dark screen |
| `motion-reduced`, `motion-reduced-open` | `/`, 390 px only | Reduced motion: the closed drawer sits in place at opacity 0 and takes no taps; `translate` isn't transitioned; `.skel-in` keeps its 160 ms wait. ☰ fades the drawer in on the compositor, and it takes the focus |
| `motion-popovers` | a chat, 1440 px only | Motion M1 (`motion-overlays.mjs`): chat ⋯, composer +, Share, settings, workspace switcher and model picker each fade in from their side and leave on a 120 ms exit, gone within 300 ms |
| `motion-panel-popovers` | chat + Preview, 1440 px only | The preview ⋯ and the file tree ⋯ drop from their buttons |
| `motion-pointer-menu` | a chat, 1440 px only | Right-click on a file link: the menu drops from the pointer, or rises when opened near the bottom; Copy path plays its exit and the toast drops in under the link; Open in panel closes the menu without its exit |
| `motion-confirm` | a chat | ⋯ → Delete chat: the menu (a sheet on phones) goes without an exit; the confirm fades and scales in over a fading backdrop; Cancel fades it out, and `close()` comes after the exit |
| `motion-handoff` | a chat, 1440 px only | ⋯ → Rename and settings → Logs close their menu without its exit; the prompt and the Logs viewer play their own |
| `motion-sheet`, `motion-sheet-handoff` | a chat, 390 px only | The phone sheet rises with its backdrop and slides out on base; focus goes back to ⋯. ☰ → settings sheet → Logs: the sheet goes at once, the Logs viewer fades and rises in |
| `motion-drawer-scrim`, `motion-drawer-scrim-close` | a chat, 390 px only | The drawer's scrim fades in and out with the drawer, on the compositor; closed, it takes no taps |
| `motion-overlays-reduced` | a chat | Reduced motion through `page.emulateMedia`: the sheet and the confirm fade in place (no travel, no scale), and their exit is 120 ms (`exitMs`, read from the CSS) |
| `motion-open-*` | a chat | Each overlay left open (menu, confirm, PointerMenu, toast, model picker, Logs), so the screenshot shows it settled |
| `motion-close-mid-entrance` | a chat | M1 review: Escape 30 ms after the chat ⋯ menu (popover, or sheet on phones) and the confirm appear, mid-entrance: each still plays its exit from where it got to, to its end |
| `motion-dialog-focus-return` | a chat | M1 review: ⋯ from the keyboard → Delete chat → Escape, then ⋯ → Rename → Escape: focus goes back to ⋯ both times, though the menu that opened each dialog has gone |
| `motion-tap-during-exit` | a chat, 390 px only | M1 review: a tap on ☰ while the chat ⋯ sheet slides out reaches the page and opens the drawer (the leaving sheet is no longer modal). The exit is stretched to 1.5 s so the tap is surely inside it |
| `motion-click-during-dialog-exit` | a chat, 1440 px only | M1 review: a click on ⋯ while the Delete chat confirm fades out opens the menu |
| `motion-sheet-reopen-during-exit` | a chat, 390 px only | M1 review: ⋯ again while its sheet slides out brings the same sheet back up, modal again with focus inside; Escape then closes it as usual |
| `motion-pointer-menu-again` | chat + Files, 1440 px only | M1 review: right-click a tree row, then another while the menu is open: the menu moves, plays its entrance again and its first item has focus, so arrow keys work |
| `motion-toast-anchor` | a long chat, 1440 px only | M1 review, local: a click on a mention whose file is missing (the reveal answers 404) shows the toast next to the mention, on the first click and again after the chat scrolled |

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
- **Text parts:** `text(s, { ms, open, later })` and `reasoning(s, { ms, open, later })`. An `open` part is still streaming and is served empty, as the engine stores it. The page loaded it mid-stream, so it shows "Writing…" until the part's final update.
  - **`later: true`:** the part starts after the page opened. No read returns it until a step emits `partStart(part)`. Then its `partDeltas(part, text)` grow on screen, as for a page that watches a reply from its first word. `s` is the text it will stream.
  - **Streaming helpers:** `openParts(scenario, chatId)` finds a chat's open parts after `defineScenario`. `partStart(part)`, `partDeltas(part, text, size)` and `partEnd(part, { text, at })` build the events OpenCode 1.18 sends: the empty opening `message.part.updated`, the `message.part.delta` events, and the final update with the whole text.
  - **Router answers:** a finished routed step gets its answer in `engine.answers`. An `open` routed step gets one in `engine.pendingAnswers`, which the fake moves to `answers` when a step emits the message's completion, so the finished reply names its model ("Auto → Gemini 3.5 Flash") as it does in the app.
- **Tool parts:** `tool(name, input, { status, output, error, title, metadata, ms })`, with `status` one of `"completed" | "error" | "running" | "pending"`, in the shapes OpenCode stores:
  - **completed:** gets the engine's own title (the relative path for file tools, the command for bash, the pattern for grep, "N todos" for todowrite) and `metadata.truncated`.
  - **running:** has no title, so the row shows its input. Bash streams `metadata: { output }`.
  - **error:** carries only the message, no title. The client still names the file relative to the project (from the message's `path.root`), like the rows that worked.
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
  - `{ watchTransitions: true }` records every CSS transition that starts from then on (for `{ transitions }` below)
  - `{ focus: sel }` focuses the first match, where a keyboard check starts (then `{ press: "Shift+Tab" }`, …)
  - `{ inject: html }` appends HTML to `<body>`, to check a CSS class on an element of its own (e.g. a `.skel-in` probe)
  - `{ watchAnimations: true }` (Chromium) traces, from then on, which CSS transitions and animations run on the compositor (for `{ composited }` below)
  - `{ emit: event | event[], every }` pushes engine events into the open stream, in the engine's shape. With `every` (ms) they go one at a time, like a model writing. The fake's stored state follows, so a reload afterwards reads it. To end a streaming turn, emit these in order (`chat-joined-midstream` does):
    1. `partEnd(part, { text })`: the whole text with `time.end` set. That is how the engine ends a streamed part.
    2. `message.updated` with the message's `info` plus `time.completed`.
    3. `session.idle` with the `sessionID`.

    The chat then shows the text, shows Send again and puts the thumbs under the reply. Get the parts with `openParts`, or from `scenario.engine.messages` after `defineScenario`.
  - `{ settle: true }` waits until the screen stops changing.
  - `{ assert: assertion }` checks one thing right there, mid-scenario (any assertion shape, `gap` too). It is reported as "step N: …".
  - `{ reload: true }` reloads the page and waits for it like the first load. `{ back: true }` is the back button.
  - `{ resize: [width, height] }` resizes the window (the run's own checks still measure at its width). `{ drag: [sel, dx] }` presses on an element, moves `dx` pixels sideways and lets go.
  - **Races with the engine's reads:**
    - `{ hold: chatId }`: from then on, that chat's messages reads are answered with the fake's state **as of the request**, but reach the page only on `{ release: chatId }`. That is a read the engine answered before what the stream sends next.
    - `{ held: chatId }` waits until such a read is waiting (up to 10 s).
    - Reads still held when the steps end are released before the final checks.
  - **Stream drops:** `{ dropStream: true }` ends the page's event stream like a network drop. The page reconnects by itself about 1.5 s later, then re-reads its state and the chats it shows. `{ awaitStream: true }` waits until it has (up to 10 s). An `emit` while the stream is down fails.
  - **Clicking a tool row:** click its toggle, `div.cursor-pointer:has-text('…') > button[aria-expanded]`. The middle of a row can be its file link, which opens the file instead.
- **`assert`:**
  - `{ visible: sel }`, `{ hidden: sel }`, `{ text: "…" }` (visible text on the page), `{ count: sel, equals | min | max }`.
  - `{ box: sel, minWidth | maxWidth }`: the first visible match's width in px.
  - `{ inView: sel, above }`: the last visible match lies inside the window, and with `above` (a selector) wholly above that element's top. For example, the end of a reply above the composer: `above: "div:has(> textarea[data-composer])"`. Assertions run before the full-page screenshot grows the window.
  - Add `gap: "why"` to make one a known gap (§3.3).
- **Overlays (Motion M1):**
  - `{ presence: { name, open, target, close } }` runs the `open` step(s), finds `target` (the element carrying `data-state`), records its entrance, runs the `close` step(s) and records its exit in the page. `open: []` means an earlier step opened it.
  - `assert { presence: name }` checks it opened at full opacity with `data-state="open"`, ran the `entered` transitions (default `["opacity"]`), then stayed mounted with `data-state="closed"`, inert and without pointer events, for 40–300 ms (`min`, `within`).
    - **A native `<dialog>` shown modal** must stop being modal as its exit starts (so the page takes taps again), stay in the top layer as a popover until it is gone, and be closed with `close()` while still in the page.
    - **Every exit must run to its end:** the element must not be removed while one of the exit's own transitions still has more than a frame to go. It is measured as the exit starts and on every frame after. A transition left over from the entrance doesn't count.
  - **WebKit:** the wall-clock bound is checked in Chromium only. Playwright's WebKit on Windows paints in software, and one 120 ms exit ends there anywhere from 150 to 550 ms after closing. In WebKit the overlay only has to be gone within a second (or the scenario's own `within`, when that is longer); the closed state, `inert`, pointer events, `exitMs` and `close()` order are checked the same.
  - Options: `exitMs` (the exit transition's length), `side` (its `data-side`; `null` for none), `notEntered`, `backdrop: true` (the `::backdrop` ends opaque, and faded in; Chromium only), `skipped: true` (a hand-off: gone without ever showing `data-state="closed"`).
  - **A close mid-entrance:** `{ presence: { …, closeAfter: ms } }` closes `ms` after the overlay appears, with no wait after each open and close step. Assert it with `midEntrance: true`.
    - The check fails if the entrance had already ended at the close, because then nothing was tested.
    - Opacity once open isn't checked, and `min` defaults to 0. The browser shortens a reversed transition by how far the entrance had got, so a barely-risen sheet is back down in about 10 ms.
    - "Runs to its end" (above) is what catches an exit cut short.
  - `{ watchEntrances: true }` records transitions from that point on. Use it before an overlay comes back that a later `{ presence: { open: [] } }` step checks. Otherwise the first `{ presence }` step starts the record.
  - `{ media: { reducedMotion: "reduce" } }` calls `page.emulateMedia` mid-scenario. `{ contextMenu: sel }` right-clicks; `{ contextMenu: [sel, { x, y }] }` fires the event at those coordinates. `{ tapAt: [x, y] }` taps a point.
  - **Added after the M1 review:**
    - `{ tapThrough: sel }` and `{ clickThrough: sel }` tap or click the centre of the first match without Playwright's wait for it to take events. Whatever is on top there gets the event, so a leaving overlay must let it through.
    - `{ checkpoint: { name, assert } }` runs any assertion mid-scenario and keeps the result. `assert { checkpoint: name }` reports it.
    - `{ respond: { path, status, method?, body? } }` answers the app's requests to `path` with this from then on, for example a 404 from `/api/workspace/reveal`.
    - `{ scrollBy: [sel, dy] }` scrolls the first match's nearest scroller by `dy` px. Negative scrolls up.
    - `assert { distance: [selA, selB], max }` checks the gap between the two first matches' boxes is at most `max` px. Touching or overlapping counts as 0.
  - **One `watchAnimations` trace per round of animations.** Chromium reuses an animation's trace id once it ends, so a trace across an open and a close can pin one animation's failure (a `visibility` transition, never composited) on another. `motion-drawer-scrim` is two scenarios for that reason.
- **`ready`:** extra selectors to wait for before anything else. Chat routes already wait for the messages, `/` for "Working in".
- **`block`:** URL globs whose requests fail, as offline or after a deploy removed old chunks (`["**/*use-typewriter*"]`). The browser's "Failed to load resource" for them is listed under Notes, not failed. A glob that blocks nothing fails the run, because the scenario would test nothing.
- **Also:** `expectConsole: [{ match: /regex/, why }]` (console errors the scenario causes on purpose, such as a `{ respond }` 404: listed under Notes like the harness's known ones, not counted), `settleMs`, `widths`, `browsers: ["chromium"]` (skip the scenario in other browsers; WebKit, for one, leaves links out of the Tab order), `colorScheme: "dark"`, `reducedMotion: "reduce"`, `model` (the picked model), `panelPrefs`.

### 3.3 Known gaps

An assertion with a `gap` note describes something the app gets wrong today: `{ text: "Save this as", gap: "the client ignores message.part.delta…" }`.

- **It must fail.** Its failure doesn't fail the run. It is listed under "Known gaps" on every run, so it stays in sight.
- **Once it passes, the run fails** with "passes now, so this gap is closed: delete its gap note in …". Delete the note in the same change that fixed the app, so the assertion guards the fix from then on.
- **Use it only for an app gap you can name,** never to quiet a flaky check.
- **No gaps today.** Round 1b closed the last one, `chat-streaming`'s reply text: the client now applies `message.part.delta` events.

### 3.4 Things that look odd but are right

- **The screen settles by itself.** The harness waits until the page's text stops changing, so typewriter animations and lazy renderers finish before the shot.
- **A streaming part shows "Writing…", not its text.** That is right for a page that opened mid-stream: the engine stores the part empty and replays nothing, so the page could only show the tail. A scenario that wants the text growing on screen starts the part `later` and streams it in steps (`chat-streaming`).
- **After a stream drop the text stops growing.** The page keeps what it saw (a true beginning) with "Writing…" under it, and ignores later deltas, because the ones sent during the drop are lost. The rest arrives with the part's final update (`chat-stream-drop`).
- **The pointer is part of the screenshot.** A click leaves the mouse where it was, and a row under it shows its hover state. `chat-streaming` hovers the composer after clicking a sidebar row, so the shot matches the baseline.
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
3. **Events:** compare the events the engine defines (`message.part.delta`, `session.status`, `permission.asked`, `permission.replied` and its `requestID`) with the cases `src/lib/engine-store.tsx` handles, and the reads it makes on connect (`/session/status`, `/permission`, `/question`).

---

## 6. Known limits

- **Chromium by default, WebKit on request.** `--browser webkit` runs Safari's engine (phone layout has differed between engines before). Neither is a real iPhone: the keyboard, safe areas and Safari's toolbars still need a device.
- **Local mode only.** The cloud layout chain is emulated for layout checks (§2.3). Cloud routes and sign-in are not faked.
- **Dev mode.** The harness runs against `pnpm dev`, so it sees development warnings (good) and is slower than production (fine). Dev-server updates mid-run are retried (§2.2).
- **A reply opened mid-stream waits for its end.** The engine stores a streaming part empty and replays nothing. So a page that opens (or reloads) while a part is being written shows "Writing…" for that part until it ends, then the whole part. Parts that start after that stream normally. A page that loses its stream keeps the text it already saw, with "Writing…" under it. A reload does not keep it: the page would need its own copy, for example in sessionStorage.
- **Block splitting is checked by a script, not a test runner.** How a streaming reply is cut into blocks (`settledBlocks` in `src/lib/use-typewriter.ts`) must never change how it looks. `node scripts/fixtures/settled-blocks-check.mjs` renders every prefix of a set of tricky replies whole and block by block, with the chat's Markdown plugins, and compares them (§1). `chat-streaming-inline-fence` checks one case on screen. Add a sample when the splitter gets a new rule.
- **Streaming smoothness is measured by hand, not gated.** The harness checks what a streaming screen shows, not its frame rate. Round 1b measured a 5,000-character reply at 100 deltas a second with a scratch script (see that round's report). Measure again after changing `src/components/parts.tsx` or `src/lib/use-typewriter.ts`.
