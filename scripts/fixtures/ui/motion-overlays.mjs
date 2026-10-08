/**
 * Motion Phase M1, overlays (docs/MOTION.md §4.1–§4.6, §5): every kind of overlay opens with its entrance, stays
 * mounted with data-state="closed" (inert, no pointer events) while it leaves, and is gone within about 300 ms.
 * A menu item that opens another overlay or navigates closes the menu without its exit (§4.3). Reduced motion
 * closes within the fast duration.
 *
 * The { presence } step and assertion are described at the top of the overlays section in scripts/ui-harness.mjs.
 */
import { backgroundChats, chat, defineScenario, HOUR, text, WORKSPACE_FILES } from "./_kit.mjs"

const c = chat("Where is the cart total?", { ago: HOUR })
c.user("Where does the cart total get rounded?")
c.assistant([text("In `src/cart.ts`: `cartTotal()` adds line items in integer cents and rounds once, on the tax line. The helpers are in `src/money.ts`.")])

const base = { route: c.route, chats: [c, ...backgroundChats()], files: WORKSPACE_FILES }

const FAST = 120
const BASE = 180
const CHAT_MENU = 'button[aria-label="Chat options"]'
/** The chat ⋯ menu's desktop popover (its label is the chat's title). */
const CHAT_POPOVER = `div:has(> ${CHAT_MENU}) > [role="dialog"]`
const SHEET = "dialog.motion-sheet"
const DIALOG = "dialog.motion-dialog"
const ITEM = (label) => `[role="menuitem"]:has-text("${label}")`
const FILE_LINK = ".chat-log button:has(code:text-is('src/cart.ts'))"
const POINTER_MENU = '[role="menu"][data-layer]'
const ESC = { press: "Escape" }
/** The phone drawer's scrim (app-shell.tsx): always mounted, faded with the drawer. */
const SCRIM = 'div[aria-hidden="true"][data-open]'

/** Opens with `open`, closes with Escape, and asserts the round trip. */
const popover = (name, open, target, side, entered = ["opacity", "transform"]) => ({
  step: { presence: { name, open, target, close: ESC } },
  check: { presence: name, side, entered, exitMs: FAST },
})

const desktop = [
  popover("chat-menu", { click: CHAT_MENU }, CHAT_POPOVER, "down"),
  popover("composer-plus", { click: 'button[aria-label="Add photos and files"]' }, '[role="dialog"][aria-label="Add photos and files"]', "up"),
  popover("share", { click: 'button[aria-haspopup="dialog"]:has-text("Share")' }, '[role="dialog"][aria-label="Share chat"]', "down"),
  popover("settings", { click: 'button:has-text("Running on this computer")' }, '[role="dialog"][aria-label="Settings"]', "up"),
  popover("workspaces", { click: 'button[aria-expanded]:has-text("acme-shop")' }, '[role="dialog"][aria-label="Workspaces"]', "down"),
  // On a chat the composer sits low, so the picker opens upward (model-picker.tsx `place`).
  popover("model-picker", { click: 'button[aria-haspopup="listbox"] >> visible=true' }, '[role="dialog"][aria-label="Choose a model"]', "up"),
]

const scenarios = [
  defineScenario({
    ...base,
    name: "motion-popovers",
    description: "M1: chat ⋯, composer +, Share, settings, workspace switcher and the model picker fade in from their side and play a fast exit.",
    widths: [1440],
    steps: desktop.map((d) => d.step),
    assert: desktop.map((d) => d.check),
  }),
  defineScenario({
    ...base,
    name: "motion-panel-popovers",
    description: "M1: the file preview's ⋯ and the file tree's ⋯ in the side pane: popovers that drop from their button.",
    widths: [1440],
    panel: { tab: "preview", file: "src/cart.ts" },
    steps: [
      { presence: { name: "preview-more", open: { click: 'button[aria-label="File actions"]' }, target: 'div:has(> button[aria-label="File actions"]) > [role="dialog"]', close: ESC } },
      { click: '[aria-label="Workspace panel"] button:has-text("Files")' },
      { presence: { name: "tree-more", open: { click: 'button[aria-label="More"]' }, target: 'div:has(> button[aria-label="More"]) > [role="dialog"]', close: ESC } },
    ],
    assert: [
      { presence: "preview-more", side: "down", entered: ["opacity", "transform"], exitMs: FAST },
      { presence: "tree-more", side: "down", entered: ["opacity", "transform"], exitMs: FAST },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-pointer-menu",
    description: "M1: right-click on a file link: PointerMenu drops from the pointer (flips up near the bottom); Copy path plays its exit and a toast drops in under the link; Open in panel hands off.",
    widths: [1440],
    steps: [
      { presence: { name: "pointer-menu", open: { contextMenu: FILE_LINK }, target: POINTER_MENU, close: { click: ITEM("Copy path") } } },
      // The toast the copy showed: it hides by itself after 1.8 s.
      { presence: { name: "toast", open: [], target: '[role="status"].motion-notice', close: { wait: 2000 }, timeout: 2_500 } },
      { presence: { name: "pointer-menu-up", open: { contextMenu: [FILE_LINK, { x: 640, y: 880 }] }, target: POINTER_MENU, close: ESC } },
      { presence: { name: "open-in-panel", open: { contextMenu: FILE_LINK }, target: POINTER_MENU, close: { click: ITEM("Open in panel") } } },
    ],
    assert: [
      { presence: "pointer-menu", side: "down", entered: ["opacity", "transform"], exitMs: FAST },
      { presence: "toast", side: "down", entered: ["opacity", "transform"], exitMs: FAST },
      { presence: "pointer-menu-up", side: "up", entered: ["opacity", "transform"], exitMs: FAST },
      { presence: "open-in-panel", skipped: true },
      { visible: '[aria-label="Workspace panel"]' },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-confirm",
    description: "M1: ⋯ → Delete chat: the menu (popover, or sheet on phones) hands off without its exit; the confirm fades and scales in over a fading backdrop, and fades out on Cancel.",
    steps: [
      { presence: { name: "menu", open: { click: CHAT_MENU }, target: `${CHAT_POPOVER}, ${SHEET}`, close: { click: ITEM("Delete chat") } } },
      { presence: { name: "confirm", open: [], target: DIALOG, close: { click: `${DIALOG} button:has-text("Cancel")` } } },
    ],
    assert: [
      { presence: "menu", skipped: true },
      { presence: "confirm", entered: ["opacity", "scale"], backdrop: true, exitMs: FAST },
      { text: "Where does the cart total get rounded?" },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-handoff",
    description: "M1: ⋯ → Rename and settings → Logs close their menu without its exit; the prompt and the Logs viewer play their own.",
    widths: [1440],
    steps: [
      { presence: { name: "menu", open: { click: CHAT_MENU }, target: CHAT_POPOVER, close: { click: ITEM("Rename") } } },
      { presence: { name: "prompt", open: [], target: DIALOG, close: ESC } },
      { presence: { name: "settings", open: { click: 'button:has-text("Running on this computer")' }, target: '[role="dialog"][aria-label="Settings"]', close: { click: ITEM("Logs") } } },
      { presence: { name: "logs", open: [], target: '[role="dialog"][aria-label="Logs"]', close: ESC } },
    ],
    assert: [
      { presence: "menu", skipped: true },
      { presence: "prompt", entered: ["opacity", "scale"], exitMs: FAST },
      { presence: "settings", skipped: true },
      // Desktop: the layer only fades (phones add a rise).
      { presence: "logs", side: null, entered: ["opacity"], exitMs: FAST },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-sheet",
    description: "M1, phones: the chat ⋯ sheet rises from below with its backdrop, and slides out (base) on Escape.",
    widths: [390],
    // Opened from the keyboard: Safari doesn't focus a button on a tap, so only then is there a focus to give back.
    steps: [{ presence: { name: "sheet", open: [{ focus: `${CHAT_MENU} >> visible=true` }, { press: "Enter" }], target: SHEET, close: ESC } }],
    assert: [
      { presence: "sheet", entered: ["translate"], backdrop: true, exitMs: BASE },
      // After the exit and close(), focus is back on the button that opened it (MOTION.md §4.2).
      { focused: `${CHAT_MENU} >> visible=true` },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-sheet-handoff",
    description: "M1, phones: ☰ → settings sheet → Logs: the sheet goes at once (it would paint above the viewer), the Logs viewer fades and rises in.",
    widths: [390],
    steps: [
      { tap: 'button[aria-label="Open menu"]' },
      { wait: 400 },
      { presence: { name: "settings", open: { tap: 'button:has-text("Running on this computer")' }, target: SHEET, close: { tap: ITEM("Logs") } } },
      { presence: { name: "logs", open: [], target: '[role="dialog"][aria-label="Logs"]', close: { tap: '[aria-label="Logs"] button[aria-label="Close"]' } } },
    ],
    assert: [
      { presence: "settings", skipped: true },
      { presence: "logs", side: "up", entered: ["opacity", "transform"], exitMs: FAST },
    ],
  }),
  // Two scenarios, one trace each: Chromium reuses an animation's trace id once it ends, so a trace across the open and
  // the close would pin the close's `visibility` (never composited, by design) on the open's opacity and translate.
  defineScenario({
    ...base,
    name: "motion-drawer-scrim",
    description: "M1, phones: ☰: the drawer's scrim fades in with the drawer (slow, arrive), on the compositor.",
    widths: [390],
    steps: [{ watchAnimations: true }, { tap: 'button[aria-label="Open menu"]' }, { wait: 400 }],
    assert: [
      { composited: ["opacity", "translate"] },
      { style: SCRIM, prop: "transition-property", equals: "translate, opacity, visibility" },
      { style: `${SCRIM}[data-open="true"]`, prop: "transition-duration", equals: "0.24s, 0.24s, 0s" },
      { style: `${SCRIM}[data-open="true"]`, prop: "opacity", equals: "1" },
      { visible: SCRIM },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-drawer-scrim-close",
    description: "M1, phones: a tap on the scrim: it fades out with the drawer (base, leave), on the compositor; closed, it takes no taps.",
    widths: [390],
    steps: [
      { tap: 'button[aria-label="Open menu"]' },
      { wait: 400 },
      { watchAnimations: true },
      // Beside the drawer (80vw, at most 320 px): that is the scrim.
      { tapAt: [370, 420] },
      { wait: 400 },
    ],
    assert: [
      { composited: ["opacity", "translate"] },
      { style: `${SCRIM}[data-open="false"]`, prop: "transition-duration", equals: "0.18s" },
      { style: `${SCRIM}[data-open="false"]`, prop: "opacity", equals: "0" },
      { style: `${SCRIM}[data-open="false"]`, prop: "pointer-events", equals: "none" },
      { hidden: SCRIM },
      { count: 'div[aria-label="Navigation"][data-open="false"]', equals: 1 },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-overlays-reduced",
    description: "M1, reduced motion (page.emulateMedia): the phone sheet and the confirm fade in place; their exit is the fast duration (120 ms).",
    steps: [
      { media: { reducedMotion: "reduce" } },
      { presence: { name: "menu", open: { click: CHAT_MENU }, target: `${CHAT_POPOVER}, ${SHEET}`, close: ESC } },
      { presence: { name: "menu-again", open: { click: CHAT_MENU }, target: `${CHAT_POPOVER}, ${SHEET}`, close: { click: ITEM("Delete chat") } } },
      { presence: { name: "confirm", open: [], target: DIALOG, close: ESC } },
    ],
    assert: [
      // Fast exit, nothing travels: a phone sheet fades (no translate); a confirm fades without its scale.
      // `exitMs` is the fast duration itself, read from the CSS; the wall-clock bound is the usual 300 ms (Chromium).
      { presence: "menu", entered: ["opacity"], notEntered: ["translate", "transform"], exitMs: FAST },
      { presence: "menu-again", skipped: true },
      { presence: "confirm", entered: ["opacity"], notEntered: ["scale"], exitMs: FAST },
    ],
  }),
]

// ---------------------------------------------------------------- M1 review findings (2026-10-08)

/** Stretches every native dialog's exit to 1.5 s, so a tap during it is reliably during it (usePresence reads the CSS). */
const SLOW_DIALOG_EXITS = `<style>dialog[data-state="closed"], dialog[data-state="closed"]::backdrop { transition-duration: 1500ms !important }</style>`
const MENU_BUTTON = 'button[aria-label="Open menu"]'
const DRAWER_OPEN = 'div[aria-label="Navigation"][data-open="true"]'
const TOAST = '[role="status"].motion-notice'
/** The toast shown with no anchor: bottom centre. */
const UNANCHORED_TOAST = `${TOAST}[class*="left-1/2"]`

// A chat long enough to scroll, with the file mention in the middle of the screen.
const long = chat("Cart rounding, step by step", { ago: HOUR })
const para = "The cart keeps every amount in integer cents from the moment a price is read, so no step in between can drift by a fraction of a cent. "
for (let i = 0; i < 3; i++) {
  long.user(`Step ${i + 1}: where does the rounding happen?`)
  long.assistant([text(para.repeat(6))])
}
long.user("And the total itself?")
long.assistant([text("In `src/cart.ts`: `cartTotal()` adds line items in integer cents and rounds once, on the tax line.")])
long.user("Thanks, and the helpers?")
long.assistant([text(para.repeat(5))])
const longBase = { route: long.route, chats: [long, ...backgroundChats()], files: WORKSPACE_FILES }

/**
 * Closed `ms` after it appears, while its entrance still runs: the exit must still play, from where it got to, to its
 * end (the browser shortens a reversed transition, so there is no minimum time).
 */
const midEntrance = (name, open, target, exitMs, entered, closeAfter = 30) => ({
  step: { presence: { name, open, target, close: ESC, closeAfter } },
  check: { presence: name, midEntrance: true, exitMs, entered },
})

scenarios.push(
  defineScenario({
    ...base,
    name: "motion-close-mid-entrance",
    description: "M1 review: Escape while an overlay is still coming in (chat ⋯ popover or phone sheet, then the confirm): it still plays its exit from where it got to, instead of vanishing on the next frame.",
    steps: [
      midEntrance("menu", { click: CHAT_MENU }, `${CHAT_POPOVER}, ${SHEET}`, null).step,
      midEntrance("confirm", [{ click: CHAT_MENU }, { click: ITEM("Delete chat") }], DIALOG, FAST).step,
    ],
    assert: [
      { ...midEntrance("menu", null, null, FAST, ["opacity", "transform"]).check, widths: [1440] },
      { ...midEntrance("menu", null, null, BASE, ["translate"]).check, widths: [390] },
      midEntrance("confirm", null, null, FAST, ["opacity", "scale"]).check,
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-dialog-focus-return",
    description: "M1 review: ⋯ (keyboard) → Delete chat → Escape, then ⋯ → Rename → Escape: focus goes back to ⋯, not <body>, though the menu that opened each dialog (a popover, or a sheet on phones) has gone.",
    steps: [
      { focus: `${CHAT_MENU} >> visible=true` },
      { press: "Enter" },
      { wait: 400 },
      { focus: ITEM("Delete chat") },
      { press: "Enter" },
      { waitFor: DIALOG },
      { wait: 400 },
      ESC,
      { wait: 400 },
      { checkpoint: { name: "after-delete", assert: { focused: `${CHAT_MENU} >> visible=true` } } },
      // From ⋯ again whatever happened above, so the second round is checked on its own.
      { focus: `${CHAT_MENU} >> visible=true` },
      { press: "Enter" },
      { wait: 400 },
      { focus: ITEM("Rename") },
      { press: "Enter" },
      { waitFor: DIALOG },
      { wait: 400 },
      ESC,
      { wait: 400 },
    ],
    assert: [{ checkpoint: "after-delete" }, { focused: `${CHAT_MENU} >> visible=true` }, { count: "dialog[open], dialog:popover-open", equals: 0 }],
  }),
  defineScenario({
    ...base,
    name: "motion-tap-during-exit",
    description: "M1 review, phones: a tap on ☰ while the chat ⋯ sheet slides out reaches the page (the drawer opens): a leaving dialog is no longer modal (MOTION.md §4.2, §8). Its exit is stretched to 1.5 s so the tap is surely inside it.",
    widths: [390],
    steps: [
      { inject: SLOW_DIALOG_EXITS },
      { tap: `${CHAT_MENU} >> visible=true` },
      { wait: 400 },
      ESC,
      { checkpoint: { name: "leaving", assert: { count: `${SHEET}[data-state="closed"]`, equals: 1 } } },
      { checkpoint: { name: "not-modal", assert: { count: `${SHEET}:modal`, equals: 0 } } },
      { tapThrough: MENU_BUTTON },
      { checkpoint: { name: "still-leaving", assert: { count: `${SHEET}[data-state="closed"]`, equals: 1 } } },
      { wait: 1600 },
    ],
    assert: [{ checkpoint: "leaving" }, { checkpoint: "not-modal" }, { checkpoint: "still-leaving" }, { count: DRAWER_OPEN, equals: 1 }, { count: SHEET, equals: 0 }],
  }),
  defineScenario({
    ...base,
    name: "motion-click-during-dialog-exit",
    description: "M1 review: a click on ⋯ while the Delete chat confirm fades out reaches the page and opens the menu (exit stretched to 1.5 s).",
    widths: [1440],
    steps: [
      { inject: SLOW_DIALOG_EXITS },
      { click: CHAT_MENU },
      { click: ITEM("Delete chat") },
      { waitFor: DIALOG },
      { wait: 400 },
      ESC,
      { checkpoint: { name: "leaving", assert: { count: `${DIALOG}[data-state="closed"]:popover-open`, equals: 1 } } },
      { clickThrough: CHAT_MENU },
      { wait: 300 },
    ],
    assert: [{ checkpoint: "leaving" }, { count: `${CHAT_POPOVER}[data-state="open"]`, equals: 1 }],
  }),
  defineScenario({
    ...base,
    name: "motion-sheet-reopen-during-exit",
    description: "M1 review, phones: ⋯ again while its sheet slides out: the same sheet comes back up, modal again (focus inside it, page inert), and Escape closes it as usual (exit stretched to 1.5 s).",
    widths: [390],
    steps: [
      { inject: SLOW_DIALOG_EXITS },
      // Opened from the keyboard: Safari doesn't focus a button on a tap, so only then is there a focus to give back.
      { focus: `${CHAT_MENU} >> visible=true` },
      { press: "Enter" },
      { wait: 400 },
      ESC,
      { wait: 200 },
      // The rise back up is the `sheet` presence step's entrance.
      { watchEntrances: true },
      { tapThrough: `${CHAT_MENU} >> visible=true` },
      { wait: 400 },
      { checkpoint: { name: "modal-again", assert: { count: `${SHEET}[data-state="open"]:modal`, equals: 1 } } },
      { checkpoint: { name: "focus-inside", assert: { focused: `${SHEET} [role="menuitem"]` } } },
      { checkpoint: { name: "risen", assert: { style: SHEET, prop: "translate", equals: "none" } } },
      { presence: { name: "sheet", open: [], target: SHEET, close: ESC, timeout: 2_500 } },
    ],
    assert: [
      { checkpoint: "modal-again" },
      { checkpoint: "focus-inside" },
      { checkpoint: "risen" },
      // Its exit is the stretched 1.5 s here.
      { presence: "sheet", entered: ["translate"], exitMs: 1500, within: 1900, min: 1000 },
      { focused: `${CHAT_MENU} >> visible=true` },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-pointer-menu-again",
    description: "M1 review: right-click a file-tree row, then another while the menu is open: the menu moves there, plays its entrance again and its first item has focus (arrow keys work).",
    widths: [1440],
    panel: { tab: "files" },
    steps: [
      { contextMenu: '[role="treeitem"][title="README.md"]' },
      { wait: 300 },
      { contextMenu: '[role="treeitem"][title="package.json"]' },
      { wait: 300 },
      { checkpoint: { name: "first-item", assert: { focused: `${POINTER_MENU} [role="menuitem"]` } } },
      { press: "ArrowDown" },
    ],
    assert: [
      { checkpoint: "first-item" },
      { count: `${POINTER_MENU}[aria-label="package.json"][data-state="open"]`, equals: 1 },
      { focused: `${POINTER_MENU} [role="menuitem"]:nth-of-type(2)` },
    ],
  }),
  defineScenario({
    ...longBase,
    name: "motion-toast-anchor",
    description: "M1 review, local: a click on a mention whose file is missing shows its toast next to the mention, on the first click and again after the chat scrolled (not bottom centre, not where the mention used to be).",
    widths: [1440],
    expectConsole: [{ match: /^Failed to load resource: the server responded with a status of 404/, why: "the { respond } step answers /api/workspace/reveal with 404 on purpose (the file is missing)" }],
    steps: [
      { respond: { path: "/api/workspace/reveal", status: 404, body: { error: "not found" } } },
      { click: FILE_LINK },
      { wait: 150 },
      { checkpoint: { name: "first-click-anchored", assert: { count: UNANCHORED_TOAST, equals: 0 } } },
      { checkpoint: { name: "first-click-next-to-it", assert: { distance: [`${TOAST}[data-state="open"]`, FILE_LINK], max: 12 } } },
      { scrollBy: [FILE_LINK, -200] },
      { wait: 300 },
      { click: FILE_LINK },
      { wait: 150 },
      { checkpoint: { name: "after-scroll-next-to-it", assert: { distance: [`${TOAST}[data-state="open"]`, FILE_LINK], max: 12 } } },
    ],
    assert: [{ checkpoint: "first-click-anchored" }, { checkpoint: "first-click-next-to-it" }, { checkpoint: "after-scroll-next-to-it" }],
  }),
)

/** Ends with the overlay open, so its screenshot shows it settled: in place, at full opacity. */
const shot = (name, description, steps, target, { wait = 400, ...more } = {}) =>
  defineScenario({
    ...base,
    name,
    description,
    ...more,
    steps: [...steps, { wait }],
    assert: [
      { style: target, prop: "opacity", equals: "1" },
      { count: `:is(${target})[data-state="open"]`, min: 1 },
      // The entrance has ended where it lands: no travel left over.
      { style: target, prop: "transform", match: String.raw`^(none|matrix\(1, 0, 0, 1, 0, 0\))$` },
    ],
  })

scenarios.push(
  shot("motion-open-menu", "M1 screenshot: the chat ⋯ menu open (popover on desktop, sheet on phones).", [{ click: CHAT_MENU }], `${CHAT_POPOVER}, ${SHEET}`),
  shot("motion-open-confirm", "M1 screenshot: the Delete chat confirm open over its backdrop.", [{ click: CHAT_MENU }, { click: ITEM("Delete chat") }], DIALOG),
  shot("motion-open-pointer-menu", "M1 screenshot: right-click on a file link: the menu at the pointer.", [{ contextMenu: FILE_LINK }], POINTER_MENU, { widths: [1440] }),
  // The toast hides by itself 1.8 s after it shows (real time), and WebKit's slower settle before the screenshot outlasts
  // that. motion-pointer-menu checks the toast in both engines; this one is for the picture.
  shot("motion-open-toast", "M1 screenshot: Copy path from the file menu: the toast under the link.", [{ contextMenu: FILE_LINK }, { click: ITEM("Copy path") }], '[role="status"].motion-notice', { widths: [1440], browsers: ["chromium"], wait: 200 }),
  shot("motion-open-model-picker", "M1 screenshot: the model picker open (upward from the composer on desktop, a full sheet on phones).", [{ click: 'button[aria-haspopup="listbox"] >> visible=true' }], '[role="dialog"][aria-label="Choose a model"], dialog[aria-label="Choose a model"]'),
  shot(
    "motion-open-logs",
    "M1 screenshot: the Logs viewer open from the settings menu (through the drawer on phones).",
    [{ click: 'button[aria-label="Open menu"]', widths: [390] }, { wait: 400, widths: [390] }, { click: 'button:has-text("Running on this computer")' }, { click: ITEM("Logs") }],
    '[role="dialog"][aria-label="Logs"]',
  ),
)

export default scenarios
