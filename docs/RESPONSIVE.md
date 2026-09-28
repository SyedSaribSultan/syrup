# syrup everywhere — responsive and mobile-native plan

Status: **approved 2026-09-28. Decisions are in §12. Phase 0 is in progress.**
Reference product: Google Gemini. We looked at the iOS app and desktop web on Mobbin, and at mobile web and iPad in screenshots taken on 2026-09-28.

---

## 0. Goal and ground rules

- **Goal:** every screen feels built for the device it's on. Phone, tablet, laptop and wide desktop all get a layout of their own, not a squeezed desktop.
- **Parity rule stays:** local and cloud get the exact same frontend. Responsive behaviour lives in shared components, never in a mode branch.
- **Calm UI stays:** motion is short and functional. That means drawers and sheets slide, and nothing decorates. `prefers-reduced-motion` turns motion off.
- **No new dependencies unless needed.** Drawers, sheets and dialogs are built on the native `<dialog>` element. It already gives focus trapping, Esc, an inert background and the top layer.
- **Where mobile matters most:** cloud. Local mode binds to `127.0.0.1`, so a phone can't reach it. Local still benefits from narrow windows, split screen and tablets.
- **Not overkill:** no custom gesture engine, no native app, no redesign of the visual language (colors, fonts and radii stay).

---

## 1. What's broken today (from the code audit)

Only the facts that shape the plan. File refs are under `src/`.

- **Sidebar is always 264px** (`components/sidebar.tsx:40`). There is no collapse, drawer or toggle. At 390px wide the chat gets about 126px.
- **The sidebar is mounted in three places.** `shell.tsx` (local), `cloud-frame.tsx` and `workspace-view.tsx` (cloud) each mount it. In cloud it remounts when you move between a workspace and Settings. Responsive state can't live in one place today.
- **Sidebar fixed-height budget is over 550px** in a cloud workspace before any chat rows show. The budget is: header, switcher, sandbox status, New chat, a 7-item nav, network editor, Stop button and user card.
- **Session header has 5 controls that never wrap** (`session-view.tsx:66-81`): cost text, Changes, Share, Logs, Files.
- **No viewport config.** There is no `viewport` export, no `viewport-fit=cover`, no `dvh`, no safe-area insets, no `theme-color` and no `color-scheme`.
- **Every input is under 16px.** iOS zooms the page when one is focused. That includes the composer at 15px.
- **Hover-only actions are unreachable on touch:**
  - chat rename and delete (`sidebar.tsx:83-86`)
  - workspace remove (`workspace-switcher.tsx:135-140`)
  - message meta line and thumbs (`message.tsx:138,159`)
  - model favourite star
  - file-tree `⋯` button
  - usage chart tooltip
- **Right-click-only actions:** the file tree, diff rows and file links.
- **Popovers are desktop-sized:**
  - The model picker is 420px wide.
  - The workspace switcher is 328px, wider than the sidebar itself.
  - Changes is `min(760px, 80vw)` with a fixed 240px file list.
  - Share is anchored to the header.
- **Native `window.prompt/confirm/alert` in 11 places.** They look foreign on mobile and can't be styled.
- **Tables overflow the page:**
  - usage (a 10-column table)
  - admin users and sandboxes
  - markdown tables in chat
  - the logs modal (fixed 86/72/220px columns)
- **Composer is always `autoFocus`.** On a phone that pops the keyboard on every navigation.

---

## 2. What we're copying from Gemini (and why)

References came from Mobbin (Gemini iOS app plus Gemini desktop web). Links are in §13. Still missing are **Gemini in a phone browser** and **Gemini on tablet**, which is what §12 asks for.

**Phone (iOS app)**
- **Top bar:** `☰` · chat title (truncated) · `✎` new chat · share · `⋯`. Nothing else.
- **Drawer:** slides from the left and dims the chat behind it. Top to bottom: search chats, New chat, sections, then the chat list. There are no per-row buttons.
- **Composer:** docked to the bottom edge. It is full-width with rounded top corners. The text field is on its own line. The bottom row is `+` · tools · spacer · model chip ("Fast") · mic or send.
- **`+` opens a small anchored menu** (Files, Photos, Camera). **Tools and sources open bottom sheets** with a grab handle.
- **New chat home:** greeting at top-left ("Hi Alex / Where should we start?") with suggestion chips below it. The composer is at the bottom, in the thumb zone.
- **Under the last answer:** 👍 👎 ↻ share copy `⋮`, always visible, not hover.
- **Scroll-to-bottom:** a round `↓` button floats just above the composer.
- **Rename:** a small centred dialog with a text field, Cancel and Save.
- **Toasts** sit just above the composer ("Chat deleted").
- **Canvas / code:** opens **full-screen** with an `✕` in the top-left. The chat is one tap away.

**Desktop web**
- **Sidebar** collapses to an **icon rail**: logo, new chat, search, sections, then settings and avatar at the bottom. The toggle sits at the top.
- **Row actions:** a `⋮` on hover opens a menu (Share, Pin, Rename, Delete).
- **Settings** is a single gear next to the user at the bottom. It is not a 7-link nav.
- **Canvas** opens as a **right pane**. The chat narrows and the rail stays.
- **The empty state centres the composer.** It moves to the bottom once a chat starts.

**Phone browser (gemini.google.com in iOS Chrome, screenshots 2026-09-28).** This is the closest match to syrup, and **it wins wherever it differs from the app.**
- **Top bar:** `☰` · **model picker as the title** ("Gemini Flash ▾") · new-chat icon · avatar.
  - The model is *not* in the composer.
- **Model dropdown:** a short anchored list with no search. Each row is a name plus a one-line description ("Fastest answers", "Advanced reasoning"). A check marks the current one. A divider separates the list from one extra option ("Extended thinking").
- **Composer is one pill:** `+` · "Ask Gemini" · mic. Nothing else until you type.
- **Empty state:** the logo mark and "Where should we start?" sit **centred vertically**. Suggestions are plain rows with `×` just above the composer.
- **`+` opens a bottom sheet with a grab handle:**
  - a row of big square tiles that scrolls sideways (Camera · Photos · Files · …)
  - then a list of tools
- **Avatar opens a bottom sheet of settings rows.** Each is an icon plus a label, in separated rounded rows: Activity, Usage limits, Skills, Your public links, Theme ▸ …
- **Drawer:**
  - about 80% of the width, with a scrim over the rest
  - header: logo + `✕`
  - **New chat** is a highlighted pill row, then Search chats, sections, and collapsible section headers ("Notebooks ▾", "Recents ▾")
  - **every chat row has a `⋮` that is always visible**
  - **user + gear pinned at the bottom**
- **Pages (Library, Gems):** top bar `☰` · "Gemini" · new-chat icon. A big left-aligned page title, section headings, and large-radius cards. Card rows scroll sideways.

**iPad mini (768px) in the browser.** Gemini just stretches the phone layout: a 320px drawer overlay, a full-width composer pill, and a full-width settings sheet. The **`+` menu is the only thing that adapts**: it becomes an anchored popover above the composer instead of a sheet.
- **We do better on tablets:**
  - content and composer capped at 720px and centred
  - sheets capped at ~560px wide and centred
  - menus shown as anchored popovers, not edge-to-edge sheets

**What we won't copy:** voice/mic, Gems, Notebooks, "sources", Spark and suggestion chips. syrup has no equivalent, so we don't add fake ones. The send button takes the mic's slot.

---

## 3. Breakpoints (window size classes)

We use Material 3's window size classes. They are based on real device data and match Gemini's behaviour.

| Class | Width | Typical devices | Nav | Panes |
|---|---|---|---|---|
| **compact** | < 600px | all phones, portrait | modal drawer | 1 |
| **medium** | 600–839px | iPad mini/Air portrait, big phones in landscape, split screen | modal drawer (same as Gemini on iPad mini) | 1 (panel goes full-screen) |
| **expanded** | 840–1199px | iPad landscape, small laptops, half-screen desktop | persistent sidebar, collapsible to rail | 2 (sidebar auto-collapses to rail when the panel opens) |
| **large** | ≥ 1200px | laptops, desktops | persistent sidebar, collapsible to rail | 2–3 (today's layout) |

**Height matters too.** A phone in landscape is under 480px tall. There we hide the greeting, shrink headers to 44px, and cap the composer at 3 lines.

**In Tailwind** (`globals.css`, `@theme`):
```css
--breakpoint-medium: 37.5rem;   /* 600px  → medium:   */
--breakpoint-expanded: 52.5rem; /* 840px  → expanded: */
--breakpoint-large: 75rem;      /* 1200px → large:    */
```
- Mobile-first: unprefixed classes are the phone layout.
- The ~10 existing `sm:`/`md:` uses move to the new names, so there is one system.
- **Two tools, two jobs:**
  - **Viewport breakpoints** decide the *shell*: drawer vs sidebar, full-screen panel vs side pane.
  - **Container queries** (`@container`, built into Tailwind 4) decide *components* that live in columns of changing width: composer, messages, prompts, tables, preview toolbar. The chat column can be 360px or 900px on the same laptop depending on whether the panel is open.
- **Touch vs mouse is separate from width.** We use `pointer-coarse:` (in Tailwind 4.3.3) for 44px hit areas and always-visible actions. A touchscreen laptop at 1400px still gets big targets.
- **JS side:** a `useWindowClass()` hook (`matchMedia` + `useSyncExternalStore`) for *behaviour only*, e.g. "open as sheet or popover". Layout itself stays in CSS, so there is no hydration flash.

---

## 4. The new shell (one component for local and cloud)

### 4.1 Restructure

- **New `AppShell`** (`components/app-shell.tsx`) owns the sidebar slot, the drawer and the main column.
  - Drawer and rail state live in **`NavProvider`** (`lib/nav.tsx`), mounted once per app, above every frame.
  - *As built:* inside a cloud workspace the sidebar still renders within `WorkspaceView`, because rename/delete and the sandbox status need that workspace's engine connection. `WorkspaceView` uses the same `AppShell`, so the layout is identical, and the state survives navigation because it lives in `NavProvider`.
- **Mounting changes:**
  - `shell.tsx` and `cloud-frame.tsx` become thin wrappers that pass mode-specific slots into it.
  - `workspace-view.tsx` stops mounting its own sidebar. It passes its workspace slots (sandbox status, network, stop) up through context.
- **Result:** the sidebar never remounts on navigation. Drawer and rail state live in one place. Local and cloud share every pixel of layout.
- **Root height:** `h-dvh` on the shell instead of the `h-full` chain. The page body never scrolls. Only inner regions do. `overscroll-behavior: none` on `body` stops pull-to-refresh and rubber-banding from moving the whole app.

### 4.2 Sidebar content diet (applies at every size)

Today's sidebar holds too much. The new order, top to bottom:

1. **Header:** `syrup` wordmark, the collapse toggle (desktop) or close `✕` (drawer), and the connection dot.
2. **Workspace switcher row** (unchanged look). Tapping it opens the switcher, which now also holds **workspace controls**: sandbox status, Network (egress), Stop workspace. These move out of the sidebar footer.
3. **New chat**, shown as a highlighted pill row (Gemini style).
4. **Search chats:** a small filter field over the chat list. It is client-side, with no backend.
5. **"Chats ▾"**, a collapsible section header. The list gets all remaining height.
   - Desktop: a `⋮` on row hover.
   - Touch: the `⋮` is always visible (as in Gemini), and long-press works too. Either opens Rename / Share / Delete.
6. **Account row**, pinned at the bottom: avatar, name, and a gear.
   - The gear opens the **settings menu** (§9): a bottom sheet on phone, a popover on desktop.
   - The menu holds Memory, Skills, Providers, Usage & cost, Account & privacy, Shared links, Logs, Admin and Theme.
   - Local mode shows the same row, with "Local" in place of the user.

Net effect: roughly **330px of fixed chrome moves out**, and the chat list gets the room.

### 4.3 Per size

**compact / medium: modal drawer**
```
┌─────────────────────────┐        ┌──────────────────┬──────┐
│ ☰  Auto ▾      ✎  ▣  ⋯  │        │ syrup          ✕ │░░░░░░│
├─────────────────────────┤        │ [■] my-app     ▾ │░░░░░░│
│                         │  tap ☰ │ (✎ New chat    ) │░░░░░░│
│   messages…             │ ─────▶ │ 🔍 Search chats   │░░░░░░│
│                         │        │ Chats ▾          │░░░░░░│
│                    (↓)  │        │ ● Fix login bug ⋮│░░░░░░│
│ ╭─────────────────────╮ │        │ ● Add dark mode ⋮│░░░░░░│
│ │ +  Ask syrup…    (↑)│ │        │   …              │░░░░░░│
│ ╰─────────────────────╯ │        │ (A) Alex      ⚙  │░░░░░░│
└─────────────────────────┘        └──────────────────┴──────┘
```
- Width `min(80vw, 320px)`, the same as the drawer in your screenshots. A scrim covers the chat, and tapping the scrim closes the drawer.
- **Swipe left on the drawer to close.** No edge-swipe to open: in mobile Safari the left-edge swipe is *browser back*, and fighting it feels broken. `☰` is the way in.
- **Navigating (tapping a chat) closes the drawer.**
- `✎` new chat sits in the top bar (Gemini does the same). `▣` is the workspace panel (§6).

**expanded / large: persistent sidebar ↔ rail**
```
Sidebar open (264px)                      Rail (64px)
┌────────────┬───────────────────────┐    ┌──┬──────────────────────────────┐
│ syrup    ◧ │ Fix login bug   ▣  ⋯  │    │◧ │ Fix login bug        ▣  ⋯    │
│ [■] my-app │                       │    │✎ │                              │
│ + New chat │   messages (≤720px)   │    │■ │      messages (≤720px)       │
│ CHATS      │                       │    │☰ │                              │
│ ● Fix log… │                       │    │  │                              │
│ ● Add dar… │  ┌─────────────────┐  │    │⚙ │   ┌──────────────────────┐   │
│ (A) Alex ⚙ │  │ composer        │  │    │Ⓐ │   │ composer             │   │
└────────────┴──┴─────────────────┴──┘    └──┴───┴──────────────────────┴───┘
```
- **Rail items:**
  - top: toggle, New chat, workspace tile (opens the switcher), chats (expands the sidebar)
  - bottom: gear, avatar
- The toggle state persists in `localStorage` (`syrup.sidebar`). **Ctrl/Cmd+B** toggles it.
- **expanded only:** opening the workspace panel auto-collapses the sidebar to the rail. It restores when the panel closes.

---

## 5. Chat surface

### 5.1 Top bar (session)

| Size | Contents |
|---|---|
| compact / medium, in a chat | `☰` · **model picker** ("Auto ▾") · `✎` · `▣` (badge = changed-file count) · `⋯` |
| compact / medium, new chat | `☰` · **model picker** · `▣` · avatar/gear (opens the settings sheet) |
| expanded / large | chat title · `Changes +12 −3` · `Share` · `▣ Files` · `⋯` (the model stays in the composer) |

- **Model picker in the top bar on phone and tablet** (Gemini mobile web):
  - Tapping it opens a **short anchored dropdown** with Auto, your favourites and recents. Each row is a name plus a one-line description, with a check on the current one.
  - A divider, then **"All models…"**, which opens the full picker as a full-height sheet with search, free badges and the detail footer.
  - syrup's catalogue is far bigger than Gemini's three models. So the short list covers the everyday choice, and the full list is one tap further.
- **`⋯` holds the rest.** The chat title sits at the top of the sheet. Then: Rename, Share, Logs, Chat info (model, tokens, cost), Delete.
- The cost text leaves the bar. It moves to Chat info and the per-message meta.
- All controls are 44×44 on coarse pointers, and the title truncates first.

### 5.2 New chat (empty state)

- **Phone and tablet:**
  - The serif heading "What are we building?" is **centred vertically** (Gemini mobile web), with the workspace name under it as a tappable chip that opens the switcher.
  - **The composer pill is docked at the bottom.**
  - In cloud, the no-keys and error cards sit just above the composer, where Gemini puts its suggestions.
- **Desktop:** unchanged, with the composer centred (same as Gemini web).
- No fake suggestion chips. We can add real ones later, e.g. "Explain this repo" when a workspace has files.

### 5.3 Composer

```
compact / medium: one pill (Gemini mobile web)
 ╭────────────────────────────────╮
 │ +   Ask syrup…             (↑) │   ← 44px targets, 16px text
 ╰────────────────────────────────╯
 grows into a rounded box once there are attachments or several lines:
 ╭────────────────────────────────╮
 │ [▣ screenshot.png ✕] [▣ a.csv ✕]│  ← chips scroll sideways, don't wrap
 │ Ask syrup… line 1              │  ← grows to ~5 lines, then scrolls
 │ line 2                         │
 │ +                          (↑) │
 ╰────────────────────────────────╯
```
- **`+` replaces the paperclip:**
  - Phone: it opens a **bottom sheet** with big tiles: **Camera** · **Photos** · **Files**. Camera is `<input accept="image/*" capture>`, and it only shows on touch devices.
  - Tablet and desktop: the same tiles in an **anchored popover** above the composer. Gemini does this on iPad.
- **No model chip in the composer on phone or tablet.** The model lives in the top bar (§5.1). Expanded and large keep today's picker in the composer.
- **Send / Stop** keep today's logic, take the mic's slot, and grow to 44px on touch.
- **Width:** the pill spans the column with 12px side margins on phone. It is capped at 720px and centred from medium up.
- **Enter key:**
  - Touch devices: Enter = **newline**, and the send button sends. This is the phone convention, since there's no Shift key.
  - Desktop: Enter still sends, and Shift+Enter still adds a newline.
- **No `autoFocus` on touch.** Desktop keeps it.
- **Container query:** in a narrow chat column (panel open on a laptop), the composer switches to the compact bottom row as well.

### 5.4 Keyboard and viewport (the hard part on mobile web)

- **`viewport` export** in `app/layout.tsx`. This was checked against `node_modules/next/dist/docs/.../generate-viewport.md`.
  ```ts
  export const viewport: Viewport = {
    width: 'device-width', initialScale: 1,
    viewportFit: 'cover',              // enables env(safe-area-inset-*)
    interactiveWidget: 'resizes-content', // Android Chrome/Firefox: keyboard shrinks dvh
    themeColor: [
      { media: '(prefers-color-scheme: light)', color: '#f3f1ea' },
      { media: '(prefers-color-scheme: dark)',  color: '#1b1a17' },
    ],
  }
  ```
- **Zoom stays allowed.** No `maximum-scale=1`, which is an accessibility failure. Zoom-on-focus is fixed at the source by making inputs 16px (§8).
- **iOS Safari hasn't shipped `interactive-widget` yet.** It's in WebKit source (Sept 2026) but not in a public Safari release. So we add a small `useVisualViewport()` hook:
  - It sets `--app-h` from `visualViewport.height` on the shell.
  - The composer stays glued above the keyboard, and the message list shrinks instead of being covered.
  - Android gets this for free from the meta tag, so the hook is a no-op there.
- **Safe areas:**
  - `pb-[env(safe-area-inset-bottom)]` on the docked composer and on sheets.
  - `pt-[env(safe-area-inset-top)]` on the top bar, for standalone/PWA mode.
  - Side insets on the shell, for landscape notches.
- **`color-scheme: light dark`** on `:root`, so native controls, scrollbars and the date picker follow dark mode.

### 5.5 Messages

- **Assistant action row is always visible on the latest answer.** Earlier answers show it on hover (desktop) or tap (touch). The row holds 👍 👎, copy, and `⋯` → Chat info for that turn (model, tokens, cost). That fixes the hover-only meta line.
- **Scroll-to-bottom `↓` button:** it appears when the user is more than 80px above the bottom (the existing stick-to-bottom logic) and floats above the composer.
- **Markdown tables** get an `overflow-x-auto` wrapper. **Code blocks** keep horizontal scroll, and the copy button is always visible on touch.
- **Tool rows:** the summary truncates, and the expanded Input/Output wraps. They already wrap; they just need the touch target size.
- **Padding:** `px-4` on phone, `px-6` from medium up. User bubbles go up to 85% width, as today.

### 5.6 Permission and question prompts

- **Phone:** the active prompt card **docks right above the composer**. Nobody should miss "Allow once / Always / Deny" because it scrolled off.
- **Buttons stack full-width** in a narrow container (container query) and sit in a row when wide.

---

## 6. Workspace panel (Files · Preview · Changes)

This is the coding-agent part Gemini doesn't have. It's where "fit everything in" matters most.

- **One panel, three tabs:** `Changes` · `Files` · `Preview`. Changes moves out of its header popover into the panel. On a phone, a 760px popover can't exist, and a tab is the natural home. **Decision needed: see §12.**

| Size | How the panel appears |
|---|---|
| compact / medium | **Full-screen layer** over the chat (like Gemini Canvas). Top bar: `✕` · tabs · `⋯`. Back/`✕` returns to the chat with scroll position kept. |
| expanded | **Side pane.** The sidebar auto-collapses to the rail. Width is clamped so the chat keeps ≥ 440px. |
| large | **Side pane**, resizable as today (320–1100px, double-click toggles 440/680). |

**Changes tab, phone:** a list of changed files with +/− counts. Tap a file for its **unified diff full-screen** (the `←` goes back to the list). The line-wrap toggle is on by default.

**Changes tab, desktop:** file list on the left, diff on the right. On a narrow pane it switches to list-then-drill-in (container query).

**Files tab:**
- Rows are 44px on touch. The `⋯` on each row is always visible on touch.
- **Long-press** opens the same actions sheet. Right-click stays for desktop.
- The toolbar icons get 44px hit areas, and the rarely used ones (Show hidden, Download .zip) go under a `⋯`.

**Preview tab:**
- Toolbar: `path` · Page/Source segmented · `⋯` (Reload, Download, Copy path, Reveal).
- HTML previews render at full width. On phone, a "Open in new tab" action is added for real-size viewing.
- CSV and code scroll sideways inside the preview only, never the page.

**The URL reflects the layer on phone** (`?panel=files`, `?panel=changes&file=…`). So:
- The **Android back button and iOS back swipe close the panel** instead of leaving the chat.
- Links to a file or diff can be shared.

---

## 7. Menus, popovers and dialogs → adaptive primitives

**New primitives** (all in `components/ui/`, built on `<dialog>`):

| Primitive | compact | medium+ |
|---|---|---|
| `Sheet` | bottom sheet, grab handle, drag-down to close, detents: *fit content* or *full* | **medium:** bottom sheet capped at 560px and centred (better than Gemini's full-bleed iPad sheet). **expanded+:** centred dialog or anchored popover (per use) |
| `Menu` | action sheet (big rows) | anchored popover (today's look) |
| `Dialog` | centred card, keyboard-aware | same |
| `Drawer` | left modal drawer | unused (sidebar is persistent) |
| `TopBar` | page header with `←` / `☰` / title / actions | page header, desktop style |

**Hooks:** `useWindowClass`, `useVisualViewport`, `useLongPress`. `useDismiss` is kept for popovers.

**Where each current layer goes:**

| Today | Becomes |
|---|---|
| Model picker (420px popover) | **phone/tablet:** a short anchored dropdown from the top-bar title (Auto, favourites, recents), and "All models…" opens a **full-height Sheet** with search, list and detail footer. **Desktop:** today's popover in the composer. The star becomes always-visible on touch. |
| Workspace switcher (328px dropdown) | **full-height Sheet** on phone, and a popover on desktop. It now also holds workspace controls (§4.2). Remove becomes a visible `⋯` per row, not hover. |
| Changes popover | **Changes tab** in the workspace panel (§6) |
| Share popover | **Sheet** on phone (fit-content), popover on desktop. The export buttons wrap. |
| File context menu (fixed, 232px) | **Menu**: action sheet on touch (via long-press or `⋯`), popover on desktop |
| Toast | bottom-centre, **above the composer** and safe area |
| File viewer modal (cloud) | full-screen on phone, centred dialog on desktop |
| Logs modal | full-screen at all sizes (as today). On phone, rows become 2-line (time · level / source · message) and the filters move into a Sheet. |
| `window.prompt/confirm/alert` (11 places) | **`Dialog`**: rename with a text field (like Gemini), confirm with a red destructive button |

---

## 8. Touch, type and accessibility baseline

- **Inputs are 16px on phones.** A single CSS rule covers everything:
  ```css
  @media (pointer: coarse) { input, textarea, select { font-size: max(16px, 1em); } }
  ```
  The composer goes to 16px as well. This removes iOS zoom-on-focus without disabling zoom.
- **Hit areas are 44×44 on coarse pointers** (Apple HIG 44pt, WCAG 2.5.8). Icons stay visually small, and padding or `::after` extends the hit box.
- **Every hover-only affordance gets a touch path.** The rule: `opacity-0 group-hover:opacity-100` becomes `pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100`, plus a `focus-visible` reveal. Keyboard users get the actions too.
- **Every right-click action gets a visible `⋯` or a long-press.**
- **Title-only info becomes visible text or a tap.** Examples: the engine dot status, the chat's workspace name, the panel shortcut.
- **The type scale is tightened while we're in there.** 366 small pixel sizes across 32 files collapse into ~6 steps: 11 / 12 / 13 / 14 / 15 / 16. That's not a redesign, it's a cleanup.
- **Focus:** drawers and sheets trap focus (free with `<dialog>`) and return it to the trigger on close.
- **Reduced motion:** sheets and drawers appear without sliding.

---

## 9. Content pages

**Settings menu (replaces the 7-link sidebar nav at every size).** It opens from the gear in the account row, and from the avatar in the phone top bar on the new-chat screen.
- **Phone and tablet:** a **bottom sheet** of icon + label rows (Gemini's avatar sheet).
- **Desktop:** the same rows in a popover above the account row.
- **Rows:** Memory · Skills · Providers · Usage & cost · Account & privacy (cloud) · Shared links · Logs · Admin (admin only) · **Theme ▸** (System / Light / Dark).
  - Theme sets the existing `data-theme` hook in `globals.css`, which nothing sets today.
- Each row goes to its page. The page has a phone top bar (`☰` · page name) and a big left-aligned title, like Gemini's Library page.

**Per page:**

| Page | Phone changes |
|---|---|
| **Providers** | Section header stacks (search goes full-width under the title). Key rows become 2-line cards with "Use" / "Remove" in a `⋯`. The add-key form stacks. |
| **Usage** | The range control goes under the title. Stats become 2 columns. **Tables become card lists** below medium: one card per model or session, key numbers first, "more" to expand. The 10-column "Routed via syrup" table becomes a card with 4 visible fields. Chart bars get tap-to-show values. |
| **Skills** | Group header wraps. "Turn all off" goes into a `⋯`. The install row stacks. |
| **Memory** | "+ Add" becomes a top-bar action. The editor fields stack, and Save/Cancel go into a sticky bottom bar. |
| **Account & privacy** | The `120px / 1fr` definition list stacks. Shared-link rows get a `⋯`. Export/Delete go full-width. |
| **Admin** | Low priority (admin-only). Every table gets an `overflow-x-auto` wrapper, and the funnel grid stacks. |
| **Legal, sign-in** | Already close. We add safe areas and 16px inputs. |
| **Public share page `/c/[id]`** | Already single-column. We add safe areas, table/code overflow and a sticky mini header. |

**Every page shares one pattern:** `TopBar` + `mx-auto max-w-[N] px-4 medium:px-6`.

---

## 10. Phases

Each phase ships on its own and leaves the app better than before. **Phases 0–2 fix "unusable on mobile".** Phases 3–6 make it feel native.

### Phase 0 — Foundations (no visible redesign yet)
- `viewport` export, `h-dvh` root, safe areas, `color-scheme`, theme-color
- breakpoint tokens (existing `sm:`/`md:` migrated), `pointer-coarse` rules, 16px inputs on touch
- `Dialog` plus the hooks `useWindowClass` and `useVisualViewport`
- all 11 `window.prompt/confirm/alert` calls replaced with `Dialog`
- Playwright screenshot sweep (dev-only), so we have "before" shots for every width
- `Sheet`, `Menu`, `Drawer`, `TopBar` and `useLongPress` get built in the phase that first uses them (1–2), so no unused code ships.
- **Done when:** no iOS zoom on focus, no native dialogs, and the sweep runs.

### Phase 1 — One shell, drawer and rail
- `AppShell` mounted once for local and cloud. `workspace-view` stops mounting its own sidebar.
- sidebar diet (§4.2): workspace controls go into the switcher, settings go behind the account row
- compact/medium drawer; expanded/large persistent sidebar ↔ rail; Ctrl/Cmd+B
- **Done when:** every route is usable at 360px, the sidebar never remounts, and local and cloud are pixel-identical.

### Phase 2 — Chat on a phone
- adaptive top bar + `⋯` menu
- composer pill, `+` sheet, model picker in the top bar, keyboard handling, no touch autofocus
- new-chat layout on phone
- message action row, `↓` button, table/code overflow
- docked permission prompts
- **Done when:** a whole chat (start, attach a photo, pick a model, approve a permission, read code, share) works one-handed on a phone.

### Phase 3 — Workspace panel everywhere
- Changes moves into the panel as a tab (pending the §12 decision)
- full-screen layer on compact/medium, side pane with auto-rail on expanded
- URL-driven layer (`?panel=`) so back closes it
- touch file tree (long-press, visible `⋯`), phone diff drill-in
- **Done when:** you can review every changed file and preview a page on a phone.

### Phase 4 — Adaptive popovers
- model picker, workspace switcher and share become sheets on phone
- file menu becomes an action sheet
- toasts move above the composer
- logs modal gets 2-line rows
- **Done when:** nothing opens off-screen or wider than the viewport at 360px.

### Phase 5 — Content pages
- settings menu (sheet on phone, popover on desktop) with Theme, TopBar on every page
- usage/admin tables → cards or overflow
- providers, skills, memory and account fixes (§9)
- type-scale cleanup (§8)
- **Done when:** no horizontal page scroll on any route at 360px.

### Phase 6 — Native polish
- **Installable PWA:** `manifest.ts`, apple-touch-icon, standalone display, theme-color. "Add to Home Screen" gives a full-screen app with no browser bars.
- sheet drag-to-dismiss, drawer swipe-to-close
- phone landscape (compact height) tuning
- iPad split-view / Slide Over checks
- desktop shortcuts: Ctrl/Cmd+Shift+O new chat, Ctrl/Cmd+K model picker, `/` focuses the composer
- a11y pass: VoiceOver on iOS, TalkBack on Android, keyboard-only on desktop

---

### As built (where it differs from the plan above)

- **Model picker on phones:** the list already opens on a short set (Auto, Fast, favourites, recents, recommended), with everything else behind "All models". So below 840px the same panel opens as a full-height sheet, not as a separate short dropdown plus a second picker. The search box doesn't autofocus on touch.
- **Composer:** one rounded box on every size, text on top, `+` and send below (the Gemini app's multi-line state). No single-line pill mode.
- **Chats section:** not collapsible. It gets a search box once there are more than 6 chats.
- **Workspace controls:** the sandbox status line stays under the switcher. Network and Stop moved into the switcher's menu, under "This workspace".
- **Chat info:** tokens and cost live in ⋯ → Chat info (a small dialog), and in the header from 1200px up.
- **Type-scale cleanup** (§8, 366 small sizes → 6 steps): not done. It's pure churn across 32 files with no user-visible win at this point.
- **Shortcuts:** Ctrl/⌘+B (sidebar), Ctrl/⌘+Shift+O (new chat), `/` (focus composer). Ctrl/⌘+K for the model picker is skipped, because two pickers are mounted (top bar and composer) and only CSS decides which one shows.
- **Keyboard on iOS:** `ViewportSync` sizes the app to `visualViewport` on touch screens. It still needs a real-iPhone check.

## 11. How we test

**Widths to check on every phase:**

| Width | Device |
|---|---|
| 360 | small Android |
| 390 / 393 | iPhone 15–17 / Pixel |
| 430 | iPhone Pro Max |
| 744 | iPad mini portrait |
| 820 / 834 | iPad Air / Pro 11 portrait |
| 1024 / 1180 / 1194 | iPad landscape |
| 1280 / 1440 / 1920 | desktop |

Plus phone landscape (~390px tall).

- **Chrome DevTools device mode** for layout. It **cannot** reproduce the iOS keyboard, safe areas or Safari toolbars.
- **Real devices are required** for keyboard, safe-area and sheet work. Two options:
  1. **Vercel preview deploy** of the cloud app (recommended). Nothing local gets exposed.
  2. Local dev over LAN. This needs `next dev -H 0.0.0.0`, which **exposes local mode's filesystem access to your network**, so it's not recommended.
- **Screenshot sweep:** a small script loops the widths above over the main routes and saves PNGs, so regressions are visible per PR. It uses Playwright as a dev dependency (`pnpm shots`).

---

## 12. Decisions (settled 2026-09-28)

1. **Gemini screenshots:** received (mobile web + iPad mini). Mobile web is the reference. Tablet uses the phone patterns with capped widths.
2. **Settings behind one gear, desktop too:** yes.
3. **Changes as a panel tab, desktop too:** yes.
4. **Enter key on touch = newline, the send button sends:** yes.
5. **Playwright screenshot sweep:** yes, dev dependency only.
6. **Real-device testing via Vercel preview deploys:** yes.
7. **Model picker in the top bar on phone/tablet:** follows Gemini mobile web. Desktop keeps it in the composer.

**Still unseen, not blocking:** Gemini mobile web *mid-conversation* and with the keyboard open. Those screens follow the Gemini iOS app references in §13 until we see them.

---

## 13. References

**Gemini (Mobbin):**
- iOS chat: [top bar + composer](https://mobbin.com/screens/f6ff7571-0641-48dc-bf1f-fcb8e0f2b583) · [keyboard open](https://mobbin.com/screens/d027d21d-ea39-4b6c-9a40-cc131dbb4dc8) · [new chat home](https://mobbin.com/screens/b1af71d2-f3f3-46ac-98f6-b5635fd1f15b)
- iOS drawer: [drawer](https://mobbin.com/screens/7838c98a-2cc1-4fea-824c-c2a32bbf01ad)
- iOS menus and dialogs: [`+` menu](https://mobbin.com/screens/e6ff39a4-3df1-475b-bdad-5aadb6e3575d) · [tools sheet](https://mobbin.com/screens/d8aaaf5f-d9b6-4092-a61b-e806187eb7fc) · [sources sheet](https://mobbin.com/screens/d6bb7092-79e2-4627-bc41-9e35b3061620) · [rename dialog](https://mobbin.com/screens/c5469d2d-7720-4980-ae36-e99f74e83f6a)
- iOS Canvas: [code full-screen](https://mobbin.com/screens/084aad68-f95f-49bb-914c-3889671090ad) · [canvas card in chat](https://mobbin.com/screens/dbdca3f6-ef1b-44c9-8931-cbba4428b08e)
- Web: [sidebar](https://mobbin.com/screens/f3b9012f-3f75-433b-a9e0-c70c2a39e9bc) · [rail](https://mobbin.com/screens/eeb82ce8-837a-4e5c-8364-621c22334f11) · [row menu](https://mobbin.com/screens/c4dd8a35-1ea4-4108-ac1d-c45ef07d8aa8) · [Canvas split](https://mobbin.com/screens/1784a2a4-743f-44f4-8a40-1b09ad4fcc86)

**Other coding agents (Mobbin):** [Codex in ChatGPT iOS](https://mobbin.com/screens/8ebafe46-9984-453e-a420-4c286164f015) · [GitHub Copilot agent iOS](https://mobbin.com/screens/13e22b46-b056-463d-b90f-5dc0b39e1613) · [Manus diff view](https://mobbin.com/screens/6834fa59-ee3a-4969-a6cc-c27bb0c9ad56) · [Mimo Build/Preview tabs](https://mobbin.com/screens/4dd36136-83f2-4cb2-979c-e91b07945c09) · [Google AI Studio split](https://mobbin.com/screens/962b58b6-1eba-4e26-a73c-6c8002e8ce2e)

**Platform guidance (checked September 2026):**
- [Window size classes — Android Developers](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)
- [Canonical layouts — Material 3](https://m3.material.io/foundations/adaptive-design/canonical-layouts) · [Navigation rail — Material 3](https://m3.material.io/components/navigation-rail/guidelines)
- [interactive-widget — HTMHell](https://www.htmhell.dev/adventcalendar/2024/4/) · [WebKit supports interactive-widget — bram.us, 2026-09-11](https://www.bram.us/2026/09/11/webkit-supports-interactive-widget-and-hopefully-safari-will-too/)
- [Viewport meta — MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Viewport_meta_element) · [env() — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env)
- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) (44pt targets, sheets)
- Next 16 `viewport` export: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-viewport.md`
