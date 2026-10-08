# Motion: one smooth, consistent system

Status: **decided 2026-10-07 (§10). M0 and M1 built 2026-10-08; M2–M3 after the capability rounds; M4–M5 later.** Drafted 2026-09-28; audit refreshed against the code on 2026-10-08.

Today almost everything in syrup appears, disappears, expands and moves instantly. This plan gives all of it one shared set of timings and curves, built into a few shared pieces and reused everywhere.

## 1. What this is, and how it relates to "Calmer UI"

- **Goal:** motion that shows *where something came from and where it went*.
  - a menu grows out of its button
  - a sheet rises from the bottom
  - a panel slides in from the side
  - a row expands
- **This partly reverses the Calmer UI commit (ddb9e70, 2026-09-28).** That commit removed two things:
  - **the pop-in on menus and dialogs:** `.pop`, which faded them in and moved them up 4 px over 150 ms, on the model picker, PointerMenu, the share popover and others
  - the fade-rise on messages, tool rows and cards, the drip and the ripples
- **This plan brings back open/close motion for overlays** (menus, sheets, dialogs), plus motion for layout changes. That changed the Calmer UI decision, so it was put to the founder: **yes, decided 2026-10-07 (§10.1).**
- **What stays from Calmer UI either way:**
  - chat content still appears without animation (the full list is in §2.9)
  - no bounce, overshoot, shimmer or springy scale
  - the waiting dots (`.orbit`), status pulse, skeletons and streaming typewriter stay as they are
- **The test for every animation:** turn it off. If you would lose track of where something went, it animates. If not, it doesn't.

## 2. Audit: everything that appears, disappears, expands or moves

Checked against the code on 2026-09-28 by three independent sweeps: conditional rendering, overlays and state, and CSS. **Re-checked on 2026-10-08 by three more sweeps** (overlays and layout; expanders, notices and swaps; lists, routes and new surfaces) against commit e64efc4. Line numbers below are from that check.

### 2.1 Already moves (keep; move onto the tokens)

| What | Where | Today |
|---|---|---|
| Hover, press and focus states, hover reveals by opacity, chevron rotation (6 chevrons) | 104 bare `transition` + 3 `transition-colors` + 1 `transition-opacity` + 1 `transition-transform` + 2 arbitrary | 150 ms, Tailwind's default curve. Tailwind 4.3.3's `transition` covers colour, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter and gradient stops. It also lists display, content-visibility, overlay and pointer-events, but those switch discretely (no `transition-discrete`). **So shadows fade too**, e.g. the active chat row's `shadow-card` |
| Phone drawer slide | `app-shell.tsx:62` | 200 ms ease-out. It already continues from the finger on release (gesture `app-shell.tsx:41-60`, inline drag style `:61`) |
| Sheet drag snap-back | `ui/sheet.tsx:61` | raw `duration-150`; the drag offset is an inline style (`:60`) |
| Usage "stale" dim, chart tooltip | `usage/page.tsx:80`, `:119` | raw `duration-200` / default |
| Skeletons, waiting dots, status pulse | `globals.css` `.skel`, `.skel-in` (240 ms after 160 ms), `.orbit`, `.pulse` | Keyframes, with a reduced-motion rule |
| Route loading skeleton | `(app)/loading.tsx:5` | Tailwind `animate-pulse` with no delay, so it flashes on fast navigations. **Not covered by reduced motion** |
| Streaming typewriter | `lib/use-typewriter.ts`, `parts.tsx:13-19` | rAF at 70 characters/s at least; it speeds up so it never lags the stream by more than 1.5 s. Its own reduced-motion check |
| Brew word rotation | `brew.tsx:23,46-53` | Swaps every 2.6 s, no fade (Calmer UI) |
| Scroll to latest | `session-view.tsx:70` | Smooth scroll, respects reduced motion |

### 2.2 Overlays (instant in and out)

| What | Where | Built on |
|---|---|---|
| Confirm / prompt / alert dialogs | `ui/dialog.tsx` | native `<dialog>`. One at a time from a queue (`:62-70`) |
| Bottom sheets | `ui/sheet.tsx` → `Sheet` | native `<dialog>`. Callers: every Popover below 840 px (`useNarrow`, `use-window-class.ts:15-16`), the model picker (`model-picker.tsx:119`), file menus on phones (`file-link.tsx:228`), the logs filters (`logs-modal.tsx:281`), the phone panel's "View options" menu (`side-panel.tsx:198-206`). The phone workspace panel itself is **not** a Sheet (§2.3) |
| Desktop popovers, 8 callers | `ui/sheet.tsx` → `Popover` | composer + (`composer.tsx:226`), chat ⋯ (`session-view.tsx:233`), share (`share-dialog.tsx:75`), row menu (`pages/row-menu.tsx:33`), workspace switcher (`workspace-switcher.tsx:66`), settings menu (`sidebar.tsx:263`), file-tree header ⋯ (`side-panel.tsx:472`), file-preview ⋯ (`file-preview.tsx:237`) |
| Model picker panel (desktop) | `model-picker.tsx:118-124, 208-212` | **own code**, not Popover. Opens up or down at runtime. Only the composer variant does this; the "bar" variant shows only below 840 px, where it is always a Sheet |
| Right-click / long-press / row ⋯ menu on files, tree rows and diff rows | `file-link.tsx:234-301` (PointerMenu) | **own code**, fixed at the pointer. Flips up when there is no room below; near the right edge it is clamped left, not flipped |
| Logs viewer (full screen) | `logs-modal.tsx:21, 228-233` | **own code**, `backdrop-blur-sm`. Only its phone Filters panel is a Sheet |
| Cloud file viewer | was `file-link.tsx:304-342` | **Deleted in M1.** Dead code, verified 2026-10-08: `view()` ran only when `cloud && !panel`, and in the cloud every FileLink sits inside PanelProvider (`workspace-view.tsx:99-100`; the legal pages have no engine, so their Markdown makes no file links). A cloud mention now opens in the panel; its menu offers "Open in panel" and "Download" |
| Drawer scrim | `app-shell.tsx:31` | mounts with `open &&` |
| File-action toasts ("Copied path", "x doesn't exist yet") | `file-link.tsx:193-220` | **own code**, remounts per toast (`key={toast.at}`, `:182`), hides on scroll |

Root cause: overlays do `if (!open) return null` or `open && …` (`sheet.tsx:15, 97`, `dialog.tsx:68`, `app-shell.tsx:31`, `logs-modal.tsx:21`, `model-picker.tsx:118-124`, `file-link.tsx:165, 181-183`, `side-panel.tsx:36`). React removes them in the same frame they close, so there is nothing left to animate out.

### 2.3 Layout moves (instant)

| What | Where | Notes |
|---|---|---|
| Sidebar ↔ icon rail (840 px and up) | `app-shell.tsx:62`, `sidebar.tsx:54-55` | `expanded:transition-none`. **The rail and the full sidebar are two separate DOM trees** swapped with `hidden` |
| Forced rail when the workspace panel opens (840–1199 px) | `side-panel.tsx:97-100`, `nav.tsx:63-68` | Set from the pane's mount effect. It snaps with the panel. Because it is tied to mount, a pane kept mounted for its exit would bring the sidebar back only after the exit (§6.1) |
| Workspace panel, desktop pane and phone layer | `side-panel.tsx:36` | Mounts with `open &&`. It also mounts/unmounts on route changes (`shell.tsx:15-21`; cloud remounts per workspace, `w/[id]/layout.tsx:13`). The phone layer is own code, a fixed full-screen `role=dialog` (`side-panel.tsx:175`), opened and closed through the URL and history (`panel.tsx:200, 205-218`) |
| Pane width on double-click (440 ↔ 680 px) | `side-panel.tsx:135` | Snaps. Live drag must stay instant |
| Changes: file list ↔ diff (phones, panes under 560 px) | `changes.tsx:147, 184` | `hidden`/`flex` swap, backed by a history entry (`panel.tsx:256-267`). Split vs drill-in is `expanded:@[560px]:flex` (`:143`); the back button is `:263-272` |
| Workspace switcher: list ↔ folder browser | `workspace-switcher.tsx:104` | Content and height snap |
| Panel tabs (Changes / Files / Preview) | `side-panel.tsx:188, 216, 243` | Bodies stay mounted with `display:none` to keep scroll. **No marker element exists**; each button has its own background. **Colour only (§10.5)** |

### 2.4 Expand / collapse (instant)

- **Tool rows and thinking:** `parts.tsx:97, 216`. Content mounts only when open.
- **File-tree folders:** `side-panel.tsx:442`. Lazy-loads: skeleton first (`:416`), then rows.
- **Cards and panels:**
  - provider cards: toggle `settings/providers/page.tsx:239`, body `:260-351`. Cards in Connected start open (`:197`).
  - skill cards: toggle `skills/page.tsx:307`, body `:335-369`. The body now starts with an "Also found at …" box (`:337-347`). It rides the card's `<Collapse>`; no motion of its own.
  - the skills install log: `skills/page.tsx:289-296`.
  - the network editor: `egress-editor.tsx:36`. It sits inside the workspace switcher popover (`workspace-view.tsx:165`, `workspace-switcher.tsx:68-73`). So it changes the popover's height on desktop and the Sheet's height on phones.
  - the memory Add editor: `memory/page.tsx:48-60`.
  - log row detail: `logs-modal.tsx:316`.
- **Live `<details>`:** `share-dialog.tsx:254`, `usage/page.tsx:357`, `logs-modal.tsx:332`.
- **Read-only `<details>`** on the share page and in the HTML export, which have no JavaScript: `parts.tsx:83, 175`.
- **Memory "more/less":** `memory/page.tsx:105-114`. It uses `line-clamp`, which the grid-rows technique can't animate.

### 2.5 Notices and banners (appear instantly, push layout)

- **Workspace banners:** the session-cap notice and "workspace didn't start" (`workspace-view.tsx:104-105, 138-150, 211-222`). They sit above the workbench, so they push the chat down.
- **New-chat notices:** four, in one `empty:hidden` container (`new-chat.tsx:116-161`).
  - **Warm-up status** (`warm-up.tsx:105-124`, mounted at `new-chat.tsx:117-121`): stage name, "usually ~N s" or "Taking longer than usual", and an optional queued line. It appears after 1.2 s of waiting and unmounts when the engine is ready. On desktop the composer is vertically centred (`new-chat.tsx:77`), so this line's height change moves the composer. Its text changes stay instant, like Brew. Inside the pending bubble (`new-chat.tsx:101`) it is chat content (§2.9).
  - **Warm-up mini-game** (`warm-up.tsx:127-148`, card `:289-304`): a canvas card, about 150 px tall. It joins the status after 3 s, on a fine pointer only. Its × removes it for good: collapse out, fast. When the engine is ready, status and game collapse as **one** motion, not two in a row. Reduced motion: §8.
  - **"Couldn't start the chat" / "This folder no longer exists"** (`new-chat.tsx:122-134`). The missing-folder variant is usually transient: for a non-Home folder the app moves to Home in the next effect (§2.8). **Render that variant instantly, or skip its entrance**, or it starts a collapse that reverses at once.
  - **"Your workspace didn't start"** (`:135-144`) and **"No API keys yet"** (`:145-160`).
  - **Presence wrappers must not stay mounted while empty.** The container and the warm-up wrapper (`:118`) rely on `empty:hidden`.
- **Provider card "last request with this key was rejected" notice:** `settings/providers/page.tsx:249-253`. It comes from a 15 s router-status poll (`:33`), so it can appear while the page is open. Present at first render: instant (§2.9). Arriving later: Notice. The card's border and dot colour (`:238, :240`) already transition.
- **Late `.sarib` tools card on the Skills page:** `skills/page.tsx:255-258`, rendered at `:143`. It renders nothing until `/api/sarib` answers, then pops in and pushes the page down. It has no skeleton, so §2.9 doesn't cover it. Never shown in the cloud.
- **Phone permission/question tray** above the composer: `session-view.tsx:169-173`. It is always mounted on phones, hides itself with `empty:hidden`, and carries `.chat-log`. It sits in the absolute bottom overlay (`:154`), so it grows up over the messages and pushes only the scroll-to-latest button. **Presence must key on Prompts having cards** (`prompts.tsx:11`), not on a conditional mount. On desktop the same cards are chat content (§2.9).
- **Status strips:** both mount under their scroll area and shrink it.
  - the file-tree strip (`side-panel.tsx:509-513`): auto-hides after 3.5 s (6 s for warnings), but stays while busy, e.g. during an upload or zip (`:318-322`).
  - the preview note (`file-preview.tsx:244-248`): always auto-hides after 3 s (`:101-105`).
- **Composer attachments row:** `composer.tsx:129-146`. It pushes layout only on the new-chat screen. In a chat the composer is in the bottom overlay (`session-view.tsx:154`), so the row grows up over the messages.
- **Moved out of this list on 2026-10-08:** the provider retry banner (chat content, §2.9), the model picker footer notice (an in-place swap, §2.6) and the composer's "over 10 MB" warning (an inline error line, §2.9).

### 2.6 In-place swaps (instant)

- **Send ↔ Stop:** `composer.tsx:167-183`.
- **Copy → Copied:** `markdown.tsx:53-73`, `share-dialog.tsx:207-213, 226-227, 339-341`, `logs-modal.tsx:365-375`. None has a min-width, so the button width changes.
- **Scroll-to-latest button:** `session-view.tsx:156-167`. It mounts and unmounts with `scrolledUp &&`; it doesn't swap with anything, so it just fades.
- **Share panel states:** `share-dialog.tsx:180-235` (skeleton `180-185`, "Share this chat" `186-198`, "Shared" `199-234`). Skeleton → first state stays instant (§2.9). **Only "Share this chat" ↔ "Shared"** (create, stop sharing) crossfades.
- **File preview:** Page ↔ Source, and switching files (`file-preview.tsx:139, 212-220`; `side-panel.tsx:232`).
- **Page swaps:** skills GitHub ↔ Paste mode (`skills/page.tsx:99-135`), memory card ↔ editor (`memory/page.tsx:89`).
- **Model picker footer notice:** `model-picker.tsx:273-280`. The footer is a fixed `h-[84px]` box and the notice replaces the Detail block in place. Nothing moves, so it is a crossfade, not `<Collapse>`.
- **Workspace switcher footer:** add form ↔ "All N slots in use" (`workspace-switcher.tsx:173-187`).
- **Settings → Connections:** GitHub token form ↔ "connected" row (`connections.tsx:54-70`). Its error line (`:71`) stays instant (§2.9).
- **Phone panel button's changed-file badge:** `side-panel.tsx:62-66`. Appearing and disappearing fades, fast, with no scale. The number changing stays instant (live data).
- **Toggle-switch knobs:** `privacy-settings.tsx:183-186`, `skills/page.tsx:330-332`. The knob moves by `left`, which `transition` doesn't animate. **The knob snaps while the track fades.**
- **Hover-revealed row actions** in the sidebar and workspace switcher: `sidebar.tsx:119-122`, `workspace-switcher.tsx:151`. They toggle `display` and snap. The switcher's "n chats" label (`:146-148`) hides with `invisible`, which also snaps. Every other hover reveal fades.
- **Segmented controls:** theme System/Light/Dark (`sidebar.tsx:291-304`), logs level filter (`logs-modal.tsx:183-194`), file preview Page/Source (`file-preview.tsx:213-219`), skills GitHub/Paste (`skills/page.tsx:99-104`), provider key free/paid (`settings/providers/page.tsx:322-328`), usage 7d/30d/90d (`usage/page.tsx:71-77`). **Colour only (§10.5):** keep the existing colour fade, no sliding marker, same as the panel tabs.
- **Theme switch:** `sidebar.tsx:281-307` → `lib/theme.ts:25-33`. About 100 elements fade their colours (and shadows, §2.1) over 150 ms while the rest snap: **a two-speed repaint**.

### 2.7 Lists

- **Sidebar chat list:** sorted newest first by `updated` (`lib/workspaces.tsx:74`), so the active chat jumps to the top after every message. New rows pop in and deleted rows vanish (`sidebar.tsx:103-134`).
- **Deliberate removals:**
  - memory Forget: `memory/page.tsx:117-127`
  - Stop on a row of the Shared-links list: `share-dialog.tsx:303-309`. The current chat's Stop sharing (`:138, 230`) is not a list removal; it is the panel swap in §2.6.
  - skill Remove: `skills/page.tsx:352-364` (no confirm; the list reloads)
  - workspace add/remove: `workspace-switcher.tsx:86-95`, × at `:159-164`; add goes through the folder browser (`:104`)
  - network host chips: `egress-editor.tsx:44`
  - provider key Remove: `settings/providers/page.tsx:266, 286-288`, RowMenu item `:296`; the key row vanishes after the reload
  - the composer attachment ×: `composer.tsx:140`; the chip vanishes, and the row with it when it was the last one
- **Provider card jumps sections, both ways** (`settings/providers/page.tsx:113-127`, filters `:68-82`).
  - Adding a key moves it up to "Connected", remounting already open (`:197`). A compact card in "All providers" (`:143-145`) jumps all the way up too.
  - Removing the last key moves it back to "Add next" or "All providers". It remounts closed there, and compact in "All providers".

### 2.8 Routes

- **Page changes** are instant. Server-rendered pages show `loading.tsx` first. Nothing uses `startTransition` or `useTransition`.
- **New chat → chat** after the first message (`router.push`, `new-chat.tsx:43`). The cloud swaps NewChat and SessionView inside the `/w/[id]` layout (`workspace-view.tsx:106`); locally it is a page change (`/` → `/s/[id]`).
  - **A pending block comes first** whenever the engine isn't ready at send time (`new-chat.tsx:39`, block `:80-104`). In practice: the cloud while the sandbox opens, and local only during engine boot.
  - It holds the warm-up status and mini-game (`:101`). The composer is hidden while pending (`:112`).
  - If the send fails, pending clears, the "Couldn't start the chat" notice appears (`:122-134`), and the composer keeps the draft (`composer.tsx:107-108`).
- **Cloud frame swaps:** going between `/w/…` and `/usage`, `/memory` or `/settings`, or switching workspace, **replaces the whole sidebar** (`cloud-frame.tsx:11-18`, `workspace-view.tsx:103`).
- **Local workspace switch:** `lib/workspaces.tsx:228-266` (pick `:233-236`, open `:246-249`, add `:252-261`) calls `setDirectory` (`engine-store.tsx:439-447`) outside a transition.
  - Re-picking the same folder no longer wipes loaded state (`engine-store.tsx` reducer, "directory" case, ~`:91-94`), so it no longer flashes a chat back to its skeleton.
- **Automatic workspace switches, with no user action:**
  - the open local folder has disappeared → Home (`lib/workspaces.tsx:206-208`, after the probe at `:189-205`; since 8c67a23)
  - no room → the first workspace (`:182-184`)
  - Both are instant and drop per-workspace state at once. Any treatment comes with route transitions (M4, §7).

### 2.9 Stays instant on purpose (the exemptions list)

- **Chat content and its state changes:**
  - messages, tool row running → done, Brew → "Thought for Xs", inline desktop permission cards (`session-view.tsx:141`)
  - retry and error lines inside the chat: the "Retrying…" part (`parts.tsx:67-68`), message errors (`message.tsx:129-133`), the session error line (`session-view.tsx:150`), which now also shows a prompt the engine refused (`engine-store.tsx:518-522`)
  - **the provider retry banner** (`session-view.tsx:142-149`). It sits inside `.chat-log` (`:124`), next to the error line, and §4.1 keeps entrance rules off `.chat-log`.
  - **the router progress line** ("X didn't answer in time. Trying another model…", `router-progress.tsx:29-38`, at `session-view.tsx:138` and `message.tsx:121`)
  - the routed-model switch note under a reply (`message.tsx:135`)
  - the new-chat pending bubble (`new-chat.tsx:80-104`), including the warm-up status inside it
- **Composer textarea auto-grow:** it happens while typing (`composer.tsx:73-74`).
- **Skeleton → content and loader → content swaps** (Calmer UI). This includes:
  - busy labels inside buttons: "Stopping…", "Creating…", "Waiting for the folder dialog…", "Checking…", "Saving…", and Brew in Install, Create link, Update link, Add key and Save (`workspace-view.tsx:168`, `workspace-switcher.tsx:225, 320`, `connections.tsx:67`, `share-dialog.tsx:196, 224, 243-249`, `skills/page.tsx:117, 131, 275`, `settings/providers/page.tsx:335`, `memory/page.tsx:195`)
  - the sidebar sandbox status line: Brew → "Running · sleeps after N min idle" / "Stopped" / "Didn't start" (`workspace-view.tsx:114-135`)
  - the Changes tab's loader, empty state, "Files touched" fallback and notes ("Line changes show up once the turn settles", "not a git repository") (`changes.tsx:148-174`)
- **List changes from search, filter or live polling.** The Changes list now updates live from the message store when a turn's summary lands, so "Files touched" flips to the line-diff list mid-session. Instant too.
- **Live data text:** the header token/cost total (`session-view.tsx:97-101`, large screens only).
- **Static notes present at load:**
  - GuiNote, the provider auth-failed note (when present at first render; arriving later is a Notice, §2.5) and the missing-asset note
  - the skills "N skills exist in more than one folder" banner (`skills/page.tsx:162-169`) and the "N copies" chip (`:312-316`). When a removal makes the banner vanish, the removed card's collapse carries the motion.
  - the workspace switcher's "Folder not found" badge and struck-through name (`workspace-switcher.tsx:140-142`), refreshed by a probe on focus
- **Inline error and success lines** outside chat. **Decided 2026-10-07: instant, no fade (§10.6).** They include:
  - the composer's "over 10 MB" warning (`composer.tsx:165`; a truncated span in the toolbar row, so it never changes height)
  - the share panel's "Valid for 24 hours…" note after copying the debug link (`share-dialog.tsx:233`)
  - `skills/page.tsx:139-140, 288`, `privacy-settings.tsx:119`, `egress-editor.tsx:57`, `settings/providers/page.tsx:93, 349`, `share-dialog.tsx:237, 358, 366`, `memory/page.tsx:182`, `workspace-switcher.tsx:171, 232, 327`, `connections.tsx:71`, and the file-tree folder error with Retry (`side-panel.tsx:417-425`)
- **Model picker's in-list "All models" / "Older" expanders.** Rows move under the keyboard highlight, so at most the new rows fade in.
- **Keyboard open/close resize** (`viewport-sync.tsx`). It can't follow the native keyboard curve.
- **Native tooltips (`title=`), images, folder icon swap, usage chart bars.**

## 3. Tokens

Defined once. Components use names, never numbers.

| Token | Value | Used for |
|---|---|---|
| `--motion-fast` | 120 ms | hover, press, chevrons, crossfades, all exits of small things |
| `--motion-base` | 180 ms | popovers, menus, dialogs, expand/collapse, notices |
| `--motion-slow` | 240 ms | sheets, drawer, workspace panel, sidebar ↔ rail |
| `--motion-shift` | 4 px | how far popovers and notices travel. 0 under reduced motion |
| `--ease-arrive` | `cubic-bezier(0.2, 0, 0, 1)` | entering: fast start, soft landing |
| `--ease-leave` | `cubic-bezier(0.3, 0, 1, 1)` | leaving: gets out of the way |
| `--ease-move` | `cubic-bezier(0.2, 0, 0, 1)` | changing size or place on screen |

- **Where they live:** plain `:root` (or `@theme static`).
  - Tailwind 4.3 drops theme variables nothing in CSS uses. The built CSS has `--ease-out` but not `--ease-in`.
  - `usePresence` also needs the durations in JS, so there is **one source**: `src/lib/motion.ts` exports the numbers, and `globals.css` mirrors them. A check script (§9) keeps them in sync.
- **Exits are one step faster than entrances:** slow → base, base → fast.
- **Tailwind defaults:** set `--default-transition-duration` and `--default-transition-timing-function` in `@theme`. That moves all 111 existing `transition` classes onto the system in one edit. It also changes chevron rotations and hover reveals, which is intended.
  - Checked: both variables exist in Tailwind 4.3.3 (`node_modules/tailwindcss/theme.css:492-493`).
- **Named utilities via `@utility`:** `motion-pop`, `motion-dialog`, `motion-sheet`, `motion-layer`, `motion-fade`, `motion-reveal`, `motion-collapse`, `motion-notice`. A component says what it is, not how long it takes.
  - **As built (M1):**
    - `motion-pop`: popovers, menus, the model picker panel, PointerMenu, the Logs viewer.
    - `motion-dialog`: Dialog, card and `::backdrop`. Added in M1, because a dialog scales where a popover travels.
    - `motion-sheet`: Sheet and its `::backdrop`.
    - `motion-notice`: toasts. M2's strips and banners use `motion-collapse`.
    - Their entrances are `@starting-style` rules after the utilities, in the motion block.
  - **Never pair one with a bare `transition` on the same element.** The built CSS puts `.transition` after every `motion-*` utility at the same specificity, so the bare transition wins and the utility's timing is dropped silently. `check-motion.mjs` fails the pair. A `motion-*` behind a variant the `transition` lacks (`transition max-expanded:motion-layer`) is fine.
  - **`motion-reveal` (M0):** hover-revealed row actions. Hidden is transparent **and** `visibility: hidden`, so hidden actions stay out of the tab order and the accessibility tree, as when they were `display: none`. Visibility turns on at once when shown and off only after the fade. Shown is `visibility: inherit`, never `visible`: a visible child of a hidden parent shows, so inside the closed phone drawer the actions would be focusable.

## 4. Building blocks

### 4.1 `usePresence(open)`: keep a closing thing mounted until its exit ends

- **Returns** `mounted` plus `data-state="open" | "closed"`. CSS animates between the two.
- **Unmounts** on `transitionend`, with three guards:
  - only when `e.target === e.currentTarget` and the property is the one being animated. Child hover transitions bubble up and would unmount early.
  - **only for a transition that started after the exit did** (a `transitionrun` seen since the close). Not on `transitioncancel` (M1 review, 2026-10-08):
    - Closing during the entrance cancels the entrance, and that `transitioncancel` would end the exit on its first frame: the overlay blinked out on a double-click or a quick open-then-Escape.
    - A property the close doesn't change (a popover's travel, a dialog's scale) finishes its entrance under the exit, and its `transitionend` isn't the exit's either.
    - A close mid-entrance reverses the entrance, and the browser shortens a reversed transition by how far it had got (CSS Transitions, "reversing shortening factor"). So the exit is shorter then, and that is correct: it plays from where the entrance got to.
  - **a timeout is required, not just a fallback.** A 0 ms duration (reduced motion) fires no events, and a genuinely cancelled exit fires no `transitionend`.
- **While closing:** `inert` plus `pointer-events: none`. `useDismiss` has already detached, so without this a tap during the fade could fire a menu item again (`use-dismiss.ts:8, 11`).
- **Entrances** use `@starting-style` (Chrome 117+, Safari 17.5+, Firefox 129+). `::backdrop` needs its **own** `@starting-style` rule; nesting it doesn't apply.
- **HTML export safety:** the export inlines every stylesheet (`share-export.ts:31-59`) and has no JavaScript. So no element may be hidden by default until JS sets `data-state`, and entrance rules stay off `.chat-log` and read-only `<details>`.
- **As built (M1):** `src/lib/use-presence.ts`.
  - `usePresence(open, { onExited, handoff })` returns `mounted`, `closing`, `ref`, `props` and `skipExit()`. Spread `props` onto the animated element: `ref`, `data-state`, and `inert` while closing.
  - **The animated property is read, not passed.** When the exit starts, it reads the element's computed transition and waits for the one that ends last. So reduced motion (a sheet fades instead of sliding) needs no second code path. The timeout is that time plus 50 ms.
  - **Hand-offs (§4.3) are built in.** An overlay with `handoff: true` that opens ends the exit of every overlay still leaving. One that starts leaving in the same commit as another opens skips its exit before paint.
  - **A side known only after measuring** (PointerMenu, a toast that flips, `Popover side="auto"`): measuring forces the element's first style, so `@starting-style` has already been used without the side. `restartEntrance(el)` re-inserts the node in place. That drops the style, so the entrance starts again from the side. Checked in Chromium and WebKit.
  - Closed `motion-*` states set `pointer-events: none`; `usePresence` sets `inert`.
  - **Where focus goes back to** (`noteOpener`, `focusReturn`): each `handoff` overlay notes what had focus when it opened. When a dialog's opener was an item of a menu that has gone since (a hand-off, §4.3), focus goes to that menu's opener instead.

### 4.2 Native `<dialog>` (Dialog, Sheet)

- **Play the exit first, then call `close()`.** This avoids the Chromium-only `overlay` property, so Safari and Firefox animate out too.
- **Also listen for `close`.** Chrome's close-watcher can force-close on a repeated Escape or Android back without user activation (`cancel` isn't cancelable then). When `close` fires, treat the dialog as gone and skip the exit.
- **Resolve a dialog's promise on the click, not after the exit.** Otherwise delete → navigate gets slower.
- **Restore focus by hand.** Native `close()` can't do it: on a hand-off its previously focused element is a menu item that has gone.
- **Release the page as the exit starts, not after it** (M1 review, 2026-10-08). §8 says a tap during an exit reaches the page. A dialog kept modal through its exit kept the page inert for 120–180 ms, so that tap was lost.
- **As built (M1):** `useModalDialog` in `ui/sheet.tsx`, shared by Sheet and Dialog.
  - `showModal()` lives in a layout effect of a component that is mounted only while the dialog is shown or leaving.
  - **As the exit starts** it calls `close()` then `showPopover()` (with `popover="manual"`).
    - The dialog stays in the top layer, so it keeps painting over everything, with its `::backdrop`, while it leaves.
    - The page is live again at once, and focus goes back to the opener then.
    - `data-layer-swap` keeps it displayed through the swap, so its transitions carry on instead of starting over. Its new `::backdrop` starts from the old one's opacity (`--backdrop-from`).
    - Without the Popover API (Chrome 114, Safari 17, Firefox 125) it stays modal until the exit ends.
  - **When the exit ends,** the unmount calls `hidePopover()` (or `close()`) before React removes the element.
  - **Opened again while leaving** (⋯ tapped again during the slide-out): it goes back to modal from where the exit had got to, and the opener is noted again.
  - **The opener** is what had focus when it opened. React's development re-run of the effect comes after `showModal()` moved focus inside, so focus already inside the dialog doesn't replace it. Without that guard, focus went to the dialog's own Cancel and then to `<body>`. Nor does nothing having focus on a re-open during the exit: Safari doesn't focus a button on a tap, it blurs what had focus.
  - A `close` event while the dialog is still open is stale (React's development re-run of effects closes and reopens it), so it is ignored. So is the one from releasing it for the exit. A real one skips the exit.
  - DialogHost keeps the finished request on screen for its exit. When the next request is already queued, the old one goes at once and the new one gets `data-backdrop="instant"`, so its backdrop doesn't fade in again.

### 4.3 Hand-offs between overlays

- `MenuList` calls `onDone()` before `onSelect()` (`sheet.tsx:146-149`). So Rename, Delete, Share, Logs and "Chat info" (`session-view.tsx:194-215`, `sidebar.tsx:260`) open **while the menu is still exiting**.
  - **On phones** (Sheet → Dialog or Sheet) that means two backdrops at once, a darker flash, and a focus fight. Worse, the exiting Sheet is a top-layer `<dialog>`, so it paints **above** the Logs viewer (`logs-modal.tsx:229`) or the panel layer (`side-panel.tsx:175`) opening under it, whatever their z-index.
  - **On desktop** popovers have no backdrop, so popover → Dialog shows one backdrop. The focus fight remains.
- **The same order elsewhere:**
  - link items close through `onClick={onDone}` while navigating (`sheet.tsx:136`): the settings links (`sidebar.tsx:254-259`), Terms and Privacy (`:268-273`)
  - PointerMenu calls `onClose()` then `it.run()` (`file-link.tsx:288-291`). "Open" can open a confirm (`:96`); "Open in panel" (`:167`) opens the full-screen panel layer on phones.
  - composer + calls `close()` then `input.click()`, handing off to the native file picker (`composer.tsx:200-203`)
  - the model picker's "Add a provider key" and "Fix key" links call `onClose()` and navigate (`model-picker.tsx:247, 381-384`)
  - a workspace switcher row calls `open(w.id)` then `onDone()` (`workspace-switcher.tsx:130-133`)
- **Rule:** when a menu item opens another overlay or navigates, **the menu closes without its exit animation**. The new overlay does the animating.
- **Stacked, not handed off:** some confirms open on top of a popover or sheet that stays open. The dialog is `data-layer`, so `useDismiss` ignores it (`use-dismiss.ts:11`).
  - cases: workspace remove/delete (`workspace-switcher.tsx:87`, button `:160`), "Stop workspace" inside the switcher (`workspace-view.tsx:157`), "Stop sharing" inside the share popover (`share-dialog.tsx:138, 305`)
  - on phones that is Sheet + Dialog stacked, two 40 % backdrops on purpose
  - **Rule:** the sheet or popover underneath stays put (no exit). Only the dialog's own backdrop fades in over it.
- **Queued dialogs back to back** (DialogHost key change, `dialog.tsx:62-70`; e.g. `admin/page.tsx:39-41`, confirm → alert): **skip the backdrop fade-out and fade-in between them.**
- **As built (M1):**
  - **An item that opens another overlay needs nothing.** Dialog, Sheet, Popover, PointerMenu and the Logs viewer are `handoff` overlays, so the one opening ends the menu's exit (§4.1).
  - **An item that navigates, or hands over to something that isn't ours,** calls `skipExit()` on its overlay (`useOverlay()`) before closing it. `MenuList` does this for every `href` row and for rows marked `handoff: true`.
  - **Marked:** the tree menu's "Upload files here…" and the composer + tiles (the native picker); "Open in panel" (the phone's panel layer isn't one of ours until M3); the preview ⋯ "Open in new tab"; Terms and Privacy; the model picker's two links; a workspace switcher row and the folder browser's add.
  - **Focus after a hand-off** goes back to the menu's own opener (⋯), not to `<body>` (M1 review). The dialog opens while the menu is still mounted, so the item it records as its opener is gone by the time it closes. `focusReturn` (§4.1) walks from the gone item to the menu's opener.
- **Over the open drawer (phones):** the settings menu and workspace switcher open as a Sheet over the drawer.
  - A link chosen there closes the Sheet (`onDone`), and the pathname change closes the drawer (`nav.tsx:83-86`) in the same frame as the route change. The menu skips its exit (rule above); the drawer plays its own close (§5).
  - "Logs" from that menu leaves the drawer open under the Logs viewer.

### 4.4 `<Collapse open>`: every expand/collapse

- **Technique:** `grid-template-rows: 0fr ↔ 1fr` plus a fade. It works in every browser without measuring heights.
- **Mount on open, unmount after close** (usePresence inside). Keeping every closed tool row's JSON mounted across a long chat is too heavy.
- **Collapsed content is `inert`,** so it isn't focusable.
- **Padding and borders go on an inner wrapper,** or they show at 0 height (tool detail has `border-t px-3 py-2`, `parts.tsx:165`).
- **`overflow: hidden` only during the tween.** Otherwise popovers inside, such as a RowMenu, get clipped.
- **Lazy content** (file-tree folders): animate once the rows arrive, not to the skeleton height and then again.
- **`empty:hidden` containers** (`new-chat.tsx:116, 118`, `session-view.tsx:170`): a wrapper that stays mounted inside them defeats `:empty`. The wrapper must replace the container or sit outside it.
- **Not for:** `line-clamp` toggles (memory more/less) or the read-only `<details>`. Both stay instant.

### 4.5 `Popover side`

- **Real sides today:**
  - up: account row (`sidebar.tsx:199`), composer + (`composer.tsx:226`), both `bottom-full`
  - right: the rail's settings menu (`sidebar.tsx:181`, `bottom-0 left-full`: opens right, bottom-aligned)
  - down: header menus and the workspace switcher, all `top-full`
  - dynamic up/down: the model picker (`model-picker.tsx:59-67`). Only the composer variant uses it. "Up" is an inline `top: -(maxHeight+8)` (`:211`), not `bottom-full`, so `transform-origin` must come from the prop, not the CSS class.
  - PointerMenu (`file-link.tsx:240-247`): flips up when there is no room below (`:245`). Near the right edge it is clamped left (`:244`), not flipped.
- **Popover gets a `side` prop** (`up | down | right | auto`), set when it opens. It sets the travel direction and `transform-origin`. The model picker panel and PointerMenu use the same prop.
- **PointerMenu's side is only known after measuring** in `useLayoutEffect`. So it must be written in that same layout effect (e.g. a data attribute) before paint, not passed as a prop at open time.
- **As built (M1):** `side` sets `data-side`. `motion-pop` turns it into `transform-origin` and a `--motion-shift` travel. The travel is `transform`, so it adds to a caller's own `translate` classes.
  - **Callers:** `up` for composer + and the account row's settings menu; `right` for the rail's settings menu; `down` for the chat ⋯, Share, RowMenu, the workspace switcher, the file tree ⋯ and the preview ⋯.
  - **The model picker is now a Popover.** A new `style` prop carries its fixed height and inline `top`; `side` comes from `place.up`.
  - **`auto`** measures, on open, where the caller's classes put it against its offset parent.
  - **PointerMenu** writes `data-side` in its layout effect, then calls `restartEntrance` (§4.1).
    - **On each open, not each mount** (M1 review): it plays the entrance and focuses its first item. A right-click on another tree row closes the menu and opens it again at the new spot while it is still leaving, so it never unmounts in between. Before the fix, arrow keys then went nowhere.

### 4.6 `Notice`: one primitive for toasts, status strips and banners

- **Toasts:** fade plus `--motion-shift` rise. A new toast crossfades the old one.
  - Today each toast remounts by key (`key={toast.at}`, `file-link.tsx:182`). A crossfade needs the old one kept mounted.
  - The file-link toast flips above or below its anchor (`file-link.tsx:204-210`), so its travel direction follows the flip.
- **Strips and banners:** `<Collapse>` plus a fade, so the layout moves smoothly instead of jumping.
- **Covers:** file-link toasts, file-tree and preview status strips, workspace banners, the new-chat notices (warm-up status and mini-game, "Couldn't start the chat" / "This folder no longer exists", "Your workspace didn't start", "No API keys yet"), the provider-card auth-failed notice when it arrives late, the late `.sarib` tools card, the composer attachments row and the phone permission tray (with the presence fixes in §2.5).
- **Not covered:** the provider retry banner (chat content, §2.9) and the model picker footer notice (a crossfade, §2.6).
- **As built (M1):** `ui/notice.tsx`: `<Notice open onExited side place>` and `useNotices()`, a list where only the newest is open.
  - Showing a toast closes the one before, which stays mounted for its fade: that is the crossfade.
  - `place(el)` positions the file-link toast before paint and returns its side. Under the mention it drops; above it (no room below) it rises; at the bottom of the screen it rises.
  - The auto-hide timer and hide-on-scroll moved into `useFileMenu`. They now close the toast with its exit instead of removing it.
  - **The anchor is measured when the toast shows,** from the mention that was used (M1 review). It was state set in the same click, so the toast got the previous render's anchor. The first click showed it bottom centre, and after a scroll it showed where the mention used to be.

### 4.7 Gestures

- **Drawer:** already continues from the finger. No work needed.
- **Sheet:** snap-back is already continuous, but dismiss jumps: `onClose` unmounts on release (`sheet.tsx:71-76`). With usePresence the slide continues from the drag position.
- **Flick:** a fast flick (> 0.5 px/ms) dismisses even under the 80 px distance.

### 4.8 Theme switch

- **Suppress transitions for one frame** while `data-theme` changes: a `data-theme-switching` attribute sets `transition: none`. The whole app then changes colour at once, instead of the current two-speed repaint. This also stops shadows fading (§2.1).

## 5. Surface by surface

| Surface | In | Out |
|---|---|---|
| Dialog | backdrop fades to 40 %; card fades and scales 0.98 → 1, base, arrive | fade, fast, leave |
| Sheet (phone) | rises from below its own height, slow, arrive; backdrop fades | slides down, base, leave; continues a drag |
| Popover, model picker panel, PointerMenu | fade + shift from its `side`, base, arrive | fade, fast, leave |
| Logs viewer | fade the layer (never animate the blur radius), base; phones add a small rise | fast |
| Drawer | slides, move onto slow + arrive; scrim fades with it | base + leave |
| Toast | fade + shift, fast | fast |
| Notices, banners, status strips, attachments row, phone permission tray, warm-up status and mini-game | `<Collapse>` + fade, base (the tray rises from the composer) | fast |
| Expanders (§2.4) | `<Collapse>`, base, move; chevron keeps rotating, fast | same |
| In-place swaps (§2.6) | crossfade, fast; Copy buttons get a min-width so they don't reflow | fast |
| Toggle knobs | `translate-x`, fast, move | same |
| Hover-revealed row actions | opacity, fast, like every other reveal | same |
| Deliberate list removals (§2.7) | — | `<Collapse>` out, fast |
| Changes list ↔ diff, workspace switcher views | slide (diff comes in from the right), base, move | slides back; **skipped when closed by a system back gesture** |
| Phone workspace panel | full-screen layer slides in from the right, slow, arrive | slides out, base, leave; skipped on a system back gesture |
| Desktop workspace pane | pane slides in while the chat narrows, slow, move | base, leave |
| Pane double-click resize | width, base, move (never during a drag) | same |
| Sidebar ↔ rail | see §6.1 | |
| Panel tabs and segmented controls | colour fade only, fast; no marker (§10.5) | same |
| Route changes | see §7 | |

## 6. Layout motion details

### 6.1 Sidebar ↔ rail

- **Two trees:** the rail and the full sidebar are separate trees. So this is a **crossfade of two trees while the width animates**, not labels fading.
  - Keep both mounted and absolutely positioned during the tween.
  - Clip them only during the tween.
- **Popovers overflow the sidebar** (the 328 px workspace switcher in a 264 px column; the rail's settings menu opens `left-full`). They must not be clipped: clip only during the tween, or portal them.
- **The forced rail must be driven from `panel.open`,** not from the pane's mount effect. Otherwise, once the pane is kept mounted during its exit, the sidebar re-expands only after the pane is gone: two motions in a row. **The panel slide and the rail collapse run as one choreographed motion.**

### 6.2 Three width/height animations

- **The three:** sidebar width, desktop pane width, `<Collapse>` height.
- **Test each** with a long chat and an open HTML/PDF preview under 4× CPU throttle.
- **Fallback if one drops frames:** slide with `transform` and let the chat column snap once at the end.

## 7. Route transitions (React `<ViewTransition>`)

- **Works in Next 16 without config.** Navigation is already a transition (`node_modules/next/dist/docs/01-app/02-guides/view-transitions.md`). Browsers without support swap instantly.
- **But it's the riskiest part of the plan.** What it needs:
  - **Placement:** enter/exit never fire in layouts. In the cloud, new chat → chat happens inside the `/w/[id]` layout, which needs a keyed `<ViewTransition key={sessionId ?? "new"}>` in WorkspaceView. Locally it's a page change. **Two implementations of one experience**, a risk to the local/cloud parity rule.
  - **No anchoring of header and composer.** They differ between the two screens: on desktop, NewChat has no header and a vertically centred composer. It needs either a shared-name morph of the composer or a plain crossfade.
  - **`default="none"` plus `transitionTypes`** on `router.push` / `Link`. Next wraps `pushState`, `replaceState` and `popstate` in `startTransition` (`app-router.js:237-246, 284-299`), so an untyped wrapper would also fire on the phone panel's history changes.
  - **Skip on system back gestures:** when `PopStateEvent.hasUAVisualTransition` is true, iOS and Android have already played their own swipe.
  - **`::view-transition { pointer-events: none }`**, and keep it short. Named elements can't be tapped while it runs.
  - **No ghosting:** the drawer and menus close as part of a navigation. Skip their CSS exits on navigation, or name them.
  - **`loading.tsx`:** a Suspense fallback breaks the old/new pair. Reshape or scope it, and give it its own enter/exit.
  - **The sidebar is replaced** on cloud frame swaps (§2.8). Anchoring it needs a shared `view-transition-name`.
  - **Import limit:** `ViewTransition` exists only in Next's bundled React, so nothing bundled outside Next may import it.
  - **Firefox:** same-document view transitions from 144, transition types from 147.
- **Decided 2026-10-07: later, as its own phase (M4, §10.4),** after §4–§6 ship.

## 8. Reduced motion and performance

- **Reduced motion is not "one token":** Tailwind's `transition` uses one duration for every property.
  - `--motion-shift` → 0 and `--motion-slow` / `--motion-base` → `--motion-fast`, inside the named utilities only.
  - **Things whose closed state is off-screen** (drawer, sheet, phone panel) get a reduced-motion closed state: opacity 0 in place, not a slide.
    - `translate` leaves their `transition-property` under reduced motion, so a swipe-close's offset snaps away instead of sliding back against the swipe (M0 review).
  - **Visibility turns on at once when a layer opens** (a 0s duration for `visibility` in the open state; closing keeps it visible until the exit ends). A hidden → visible transition is still `hidden` in its first frame. That frame broke two things in M0 (review, 2026-10-08):
    - the drawer's `focus()` on open failed, leaving focus on `<body>`
    - Chromium had nothing painted to hand to the compositor, so the slide ran on the main thread
  - **A closed or closing layer takes no pointer events** (§4.1), so a quick tap during the exit reaches the page. A leaving Dialog or Sheet is no longer modal either (§4.2).
  - The sidebar width changes instantly (its `transition-property` changes), and the two trees just crossfade.
  - `loading.tsx` moves from `animate-pulse` to `.skel` / `.skel-in`, which respect reduced motion. **`.skel-in` keeps its 160 ms wait** under reduced motion (a threshold, not motion) and shows without fading.
  - The per-component `motion-reduce:transition-none` classes go away.
  - **The warm-up mini-game ignores reduced motion:** its rAF loop (`warm-up.tsx:226-281`) moves spills on its own. Under reduced motion, don't auto-mount it, or start it paused until the first input. The game itself stays as shipped (ROADMAP decision 4).
- **Performance rules:**
  - Animate only `transform` and `opacity`, except the three in §6.2.
  - No `will-change` left on after an animation.
  - **Never animate `backdrop-filter`.** Fade the layer, or drop the blur on phones.
  - **Target:** 60 fps on a mid-range Android phone. Check in Chrome DevTools with 4× CPU throttle, then on a real phone.

## 9. Keeping it consistent

- **`scripts/check-motion.mjs`, chained into lint** (`"lint": "eslint && node scripts/check-motion.mjs"`; today lint is plain `eslint`). It fails on:
  - raw `duration-*`, `delay-*`, `ease-[…]` and `animate-*` classes
  - `transition-none`, outside an allow-list
  - `animation:` / `transition:` in CSS outside the token and keyframe blocks
  - `src/lib/motion.ts` and `globals.css` disagreeing
- **Allow-list** (motion §1 keeps): `.pulse`, `.orbit`, `.skel`, `.skel-in` and their reduced-motion block; the inline `transition: "none"` drag styles (`sheet.tsx:60`, `app-shell.tsx:61`).
- **As built (M0, 2026-10-08):**
  - **The motion block** in `globals.css` runs from `/* @motion-begin` to `/* @motion-end */`. It holds the tokens, the Tailwind defaults, the `motion-*` utilities, the theme-switch rule and the four loops. `transition` and `animation` may be written there and nowhere else in CSS.
  - **Allow-lists** live in `ALLOW` at the top of the script, each entry with its reason. The `transition-none` list is empty today.
  - **Also fails on:** every Tailwind `ease-*` class, not just `ease-[…]`; arbitrary `[transition:…]` / `[animation:…]` properties; inline `transition*` / `animation*` styles other than the two drag styles; any `will-change` left on (§8).
  - **It also checks** that `--default-transition-duration` and `--default-transition-timing-function` read the tokens.
  - **Tightened after the M0 review (2026-10-08).** It now also fails on:
    - **Arbitrary overrides:** `[--tw-duration:…]`, `[--tw-ease:…]`, `[--motion-…:…]` and `[--ease-…:…]`.
    - **Layout transitions:** `transition-all`, and `transition-[…]` naming a layout property (an empty `ALLOW.layoutTransition` waits for §6.2's three).
    - **A bare `transition*` class paired with a `motion-*` utility** (§3).
    - **JS that times things itself:** `.style.transition… =` assignments, `setProperty` of a motion property or a token, and the Web Animations API (`ALLOW.webAnimations`, empty).
    - **Raw durations and curves inside the motion block.** Declarations read `var(--motion-…)` / `var(--ease-…)`; `0s` and `step-start` / `step-end` are allowed. The loops' literals are allow-listed by selector and value in `ALLOW.cssTiming`.
    - **Token declarations outside the block's one `:root`.** The reduced-motion `:root` may only set `--motion-shift: 0px`.
  - **Tightened after the M1 review (2026-10-08).** Inside the motion block it now also fails on:
    - **A `transition-property` (or `transition` shorthand) naming anything but** opacity, transform, translate, scale, rotate, visibility or a colour. So `all`, layout properties, `filter`, `backdrop-filter` and `box-shadow` fail (§8). §6.2's three go in `ALLOW.layoutTransition` as `{ utility, props }` in M3.
    - **A `motion-*` utility whose exit isn't one step faster than its entrance** (slow → base, base → fast; fast stays fast; §3). The harness's `exitMs` checks the same at runtime.
  - **A self-test** plants each of those forms, plus look-alikes that must pass, on every run. If the checker stops catching one, it fails before it checks `src`.
- **Migrate the three raw timings:** `sheet.tsx:61`, `app-shell.tsx:62`, `usage/page.tsx:80`.
- **New overlays must use Dialog, Sheet or Popover. New expanders use `<Collapse>`, new notices use `Notice`.** That's where the motion lives.

## 10. Decisions

Taken by the founder on **2026-10-07** (ROADMAP.md decisions 9–12).

1. **Overlays:** bring back a short open/close on menus, sheets and dialogs? **Yes** (decision 9). This partly undoes the Calmer UI change (§1); chat content stays instant.
2. **Feel:** quick or softer? **Quick: 120 / 180 / 240 ms** (decision 9). The tokens in §3 already use these.
3. **Sidebar ↔ rail:** animate it (with the tree crossfade, §6.1)? **Yes, animate, with the §6.2 fallback** (decision 10). It ships in M3.
4. **Route transitions** (§7): now, later, or never? **Later, as its own phase: M4** (decision 11).
5. **Panel tabs and segmented controls:** colour only or a sliding marker? **Colour only** (decision 12). No new markup; tabs and segmented controls match.
6. **Inline error and success lines** outside chat: instant or a fast fade? **Instant** (decision 12).

## 11. Phases

Each phase ends usable and deployable.

- **M0 — Tokens and cleanup.** Built 2026-10-08, review findings fixed the same day. These UI harness scenarios check it:
  - `motion-tokens`, `motion-theme-switch` and `motion-reduced(-open)`
  - `motion-drawer-open`: focus on open, and the slide on the compositor
  - `motion-row-actions-keyboard` and `motion-switcher-actions`: hidden actions stay out of the tab order
  - tokens in `:root` + `src/lib/motion.ts`
  - Tailwind defaults, reduced-motion base, `check-motion.mjs` in lint
  - migrate the three raw timings
  - `loading.tsx` → `.skel`
  - toggle knobs → `translate-x`
  - display-toggled row actions → `motion-reveal` (opacity, with visibility so the tab order is unchanged)
  - theme-switch one-frame suppression
- **M1 — Overlays.** Built 2026-10-08 ("As built" in §3 and §4.1–§4.6).
  - `usePresence`, then Dialog, Sheet and Popover (with `side`), the hand-off rule (§4.3), drawer scrim
  - move onto the system: model picker panel, PointerMenu, Logs viewer
  - `Notice` for toasts
  - delete the cloud file viewer (verified unreachable, §2.2)
  - **Checked by** `scripts/fixtures/ui/motion-overlays.mjs`, with the harness's `{ presence }` step and assertion. Each overlay opens, then shows `data-state="closed"` (inert, no pointer events) for a moment, then is gone within 300 ms.
    - `motion-popovers`, `motion-panel-popovers`: the header and sidebar popovers, the model picker and the two panel ⋯ menus, with their sides.
    - `motion-pointer-menu`: down, and flipped up. Copy path plays its exit and its toast drops in; Open in panel hands off.
    - `motion-confirm` (both widths), `motion-handoff`, `motion-sheet-handoff`: menu → confirm, prompt and Logs, from a desktop popover and a phone sheet. The menu never shows a closed frame.
    - `motion-sheet`: the phone sheet rises with its backdrop and exits on base. `close()` comes after the exit, and focus goes back to ⋯.
    - `motion-drawer-scrim`, `motion-drawer-scrim-close`: the scrim fades with the drawer, on the compositor.
    - `motion-overlays-reduced`: `page.emulateMedia({ reducedMotion: "reduce" })`. The sheet and the confirm fade without travel or scale, and their exit is the fast duration (120 ms, read from the CSS). Measured, they go 125–160 ms after closing in Chromium. Wall-clock bounds are checked in Chromium only: Playwright's WebKit on Windows paints in software and ends the same exit 150–550 ms after closing.
    - `motion-open-*`: each overlay settled open, for the screenshots.
  - **Fixed after the M1 review (2026-10-08),** each with a scenario that fails without the fix:
    - `motion-close-mid-entrance`: closing during the entrance plays the exit instead of vanishing (§4.1).
    - `motion-dialog-focus-return`: focus goes back to ⋯ after a menu → dialog hand-off, at both widths (§4.2, §4.3).
    - `motion-tap-during-exit`, `motion-click-during-dialog-exit`, `motion-sheet-reopen-during-exit`: a leaving Sheet or Dialog lets taps through, and comes back modal when reopened (§4.2).
    - `motion-pointer-menu-again`: a second right-click focuses the moved menu (§4.5).
    - `motion-toast-anchor`: the toast shows next to the mention on the first click and after a scroll (§4.6).
    - `check-motion.mjs`: `transition-property` and the exit step inside the motion block (§9).
  - **Not covered by a scenario:** two queued dialogs back to back (only the admin page queues two), and a drag-dismissed sheet continuing from the finger (M5 checks gestures on devices).
- **M2 — Collapse and notices.**
  - `<Collapse>` for all of §2.4 except the exemptions
  - `Notice` for §2.5
  - collapse-out for deliberate list removals
- **M3 — Swaps and layout.**
  - the in-place crossfades (§2.6)
  - Changes drill-in and switcher views
  - phone panel layer and desktop pane
  - pane resize
  - sidebar ↔ rail with the forced-rail choreography
- **M4 — Route transitions.** Later, its own phase (§10.4).
- **M5 — Gestures and devices.** Later.
  - sheet dismiss continuation and flick
  - back-gesture guards
  - real iPhone and Android checks, with and without reduced motion, under 4× throttle
- **Later, optional:** FLIP for the sidebar chat list reorder and the provider card move.

**Done when:** everything in §2.2–§2.8 moves as §5 says, §2.9 stays instant, every timing comes from §3, and `check-motion.mjs` passes.
