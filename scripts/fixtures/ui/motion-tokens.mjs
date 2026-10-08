/**
 * Motion Phase M0 (docs/MOTION.md §3, §4.8, §8, §11): the tokens reach the page, hover reveals fade,
 * the phone drawer runs on motion-layer, a theme switch repaints in one frame, and reduced motion
 * turns the drawer's slide into a fade.
 */
import { backgroundChats, defineScenario, WORKSPACE_FILES } from "./_kit.mjs"

const FAST = "0.12s"
const BASE = "0.18s"
const MOVE = "cubic-bezier(0.2, 0, 0, 1)"
const LEAVE = "cubic-bezier(0.3, 0, 1, 1)"
const DRAWER = 'div[aria-label="Navigation"]'
/** A sidebar chat row's Rename / Delete buttons (only on chats of the open workspace). */
const ACTIONS = 'div:has(> button[title="Rename"])'
const ROW_ACTIONS = `nav li ${ACTIONS}`
const ROW_TIME = 'nav li:has(button[title="Rename"]) a > span:last-child'
/** The sidebar rows that have actions, in order (Playwright's `>> nth=` picks one). */
const ROWS = 'nav li:has(button[title="Rename"])'
const SETTINGS = 'button:has-text("Running on this computer")'
const DARK = '[role="radio"]:has-text("Dark")'
const OPEN_MENU = 'button[aria-label="Open menu"]'
/** A `.skel-in` group of its own, so its timing can be read under reduced motion (loading.tsx uses the same class). */
const SKEL_PROBE = '<div id="skel-in-probe" class="skel-in" style="position:fixed;left:0;top:0;width:1px;height:1px"></div>'

const base = { route: "/", chats: backgroundChats(), files: WORKSPACE_FILES }

const scenarios = [
  defineScenario({
    ...base,
    name: "motion-tokens",
    description: "M0: bare `transition` runs on the tokens; the drawer is motion-layer below 840 px only; sidebar row actions fade in on hover.",
    steps: [{ hover: ROWS, widths: [1440] }, { wait: 300, widths: [1440] }],
    assert: [
      // Tailwind's defaults now read the tokens: every bare `transition` is fast + move.
      { style: 'button[aria-label="Send"]', prop: "transition-duration", equals: FAST },
      { style: 'button[aria-label="Send"]', prop: "transition-timing-function", equals: MOVE },
      // Phones: the closed drawer leaves on base + leave, and takes no taps while it does (MOTION.md §4.1).
      // Desktop: a column, no transition at all (sidebar ↔ rail is M3), and it must take clicks.
      { style: DRAWER, prop: "transition-duration", equals: BASE, widths: [390] },
      { style: DRAWER, prop: "transition-timing-function", equals: LEAVE, widths: [390] },
      { style: DRAWER, prop: "transition-property", equals: "translate, opacity, visibility", widths: [390] },
      { style: `${DRAWER}[data-open="false"]`, prop: "pointer-events", equals: "none", widths: [390] },
      { style: DRAWER, prop: "transition-duration", equals: "0s", widths: [1440] },
      { style: DRAWER, prop: "pointer-events", equals: "auto", widths: [1440] },
      // Hover reveal by opacity, not display: hovered row's actions are shown, the others are transparent…
      { style: `nav li:hover ${ACTIONS}`, prop: "opacity", equals: "1", widths: [1440] },
      { style: `nav li:not(:hover) ${ACTIONS}`, prop: "opacity", equals: "0", widths: [1440] },
      { style: ROW_ACTIONS, prop: "display", equals: "flex" },
      // …and invisible, so they are out of the tab order and the accessibility tree (as when they were display: none).
      { hidden: 'nav li:not(:hover):not(:focus-within) button[title="Rename"]', widths: [1440] },
      { style: 'nav li:hover:has(button[title="Rename"]) a > span:last-child', prop: "opacity", equals: "0", widths: [1440] },
      // Touch screens: the actions are always there, the time is not…
      { style: ROW_ACTIONS, prop: "opacity", equals: "1", widths: [390] },
      { style: ROW_TIME, prop: "display", equals: "none", widths: [390] },
      // …but only as visible as the drawer around them: shown is `inherit`, so the closed drawer's are neither
      // focusable nor announced (motion-drawer-open checks they show once it opens).
      { hidden: `${DRAWER}[data-open="false"] button[title="Rename"]`, widths: [390] },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-row-actions-keyboard",
    description: "M0: hidden row actions are out of the tab order. Shift+Tab from a row's link skips the row above's actions; Tab then reaches them.",
    widths: [1440],
    // WebKit leaves links out of the Tab order (Safari's default), so this walk only means something in Chromium.
    // motion-tokens' { hidden } check covers WebKit: the hidden actions are invisible, not just transparent.
    browsers: ["chromium"],
    steps: [{ focus: `${ROWS} >> nth=1 >> a` }, { press: "Shift+Tab" }, { press: "Tab" }],
    assert: [
      // With the actions focusable while transparent, Shift+Tab lands on row 1's Delete, and Tab then leaves the row.
      { focused: `${ROWS} >> nth=0 >> button[title="Rename"]` },
      { visible: `${ROWS} >> nth=0 >> button[title="Rename"]` },
      { hidden: 'nav li:not(:hover):not(:focus-within) button[title="Rename"]' },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-switcher-actions",
    description: "M0: the workspace switcher's row actions show on the hovered (or focused) row only; the other rows' are invisible.",
    widths: [1440],
    steps: [
      { click: 'button[aria-expanded="false"]:has-text("acme-shop")' },
      // The row, not its actions: those are invisible until the row is hovered.
      { waitFor: 'div.group:has(button[aria-label="Open folder"]) >> nth=0' },
      { hover: 'div.group:has(button[aria-label="Open folder"]) >> nth=0' },
      { wait: 300 },
    ],
    assert: [
      { visible: 'div.group:hover button[aria-label="Open folder"]' },
      { hidden: 'div.group:not(:hover):not(:focus-within) button[aria-label="Open folder"]' },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-drawer-open",
    description: "M0: ☰ slides the phone drawer in on the compositor, and the drawer takes the focus (visibility turns on at once).",
    widths: [390],
    steps: [{ watchAnimations: true }, { tap: OPEN_MENU }, { wait: 400 }],
    assert: [
      { style: DRAWER, prop: "transition-duration", equals: "0.24s, 0.24s, 0s" },
      { focused: DRAWER },
      { composited: ["translate"] },
      { visible: `${DRAWER}[data-open="true"] nav` },
      // A touch screen: the row actions show without a hover, now that the drawer around them does.
      { visible: `${DRAWER}[data-open="true"] button[title="Rename"]` },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-theme-switch",
    description: "M0: System (light) → Dark from the settings menu starts no transition (one-frame suppression, MOTION.md §4.8); the dark new-chat screen.",
    steps: [
      { tap: OPEN_MENU, widths: [390] },
      { wait: 400, widths: [390] },
      { click: SETTINGS },
      { waitFor: DARK },
      // Hover first, so the pointer's own hover fade isn't counted as part of the switch.
      { hover: DARK, widths: [1440] },
      { wait: 300 },
      { watchTransitions: true },
      { click: DARK },
      { wait: 300 },
    ],
    assert: [
      // outline-color: focus leaves the menu's first item on touch-down, which WebKit runs a frame before the click.
      // That is focus moving, not the theme; the 100+ colour and shadow fades this guards against are all counted.
      { transitions: { max: 0, ignore: ["outline-color"] } },
      { count: 'html[data-theme="dark"]', equals: 1 },
      { count: "html[data-theme-switching]", equals: 0 },
      { visible: `${DARK}[aria-checked="true"]` },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-reduced",
    description: "M0, reduced motion: the closed phone drawer sits in place (no slide) at opacity 0 and takes no taps; skeletons still wait 160 ms.",
    widths: [390],
    reducedMotion: "reduce",
    steps: [{ inject: SKEL_PROBE }, { wait: 300 }],
    assert: [
      { style: `${DRAWER}[data-open="false"]`, prop: "translate", equals: "none" },
      { style: `${DRAWER}[data-open="false"]`, prop: "opacity", equals: "0" },
      { style: `${DRAWER}[data-open="false"]`, prop: "visibility", equals: "hidden" },
      { style: `${DRAWER}[data-open="false"]`, prop: "pointer-events", equals: "none" },
      { hidden: `${DRAWER}[data-open="false"] button[title="Rename"]` },
      { style: DRAWER, prop: "transition-duration", equals: FAST },
      // translate is not transitioned: a swipe-close's offset snaps away rather than sliding back against the swipe.
      { style: DRAWER, prop: "transition-property", equals: "opacity, visibility" },
      // The 160 ms don't-flash wait is a threshold, not motion: it stays under reduced motion (only the fade goes).
      { style: "#skel-in-probe", prop: "animation-name", equals: "skel-appear" },
      { style: "#skel-in-probe", prop: "animation-delay", equals: "0.16s" },
      { style: "#skel-in-probe", prop: "opacity", equals: "1" },
    ],
  }),
  defineScenario({
    ...base,
    name: "motion-reduced-open",
    description: "M0, reduced motion: ☰ fades the phone drawer in, fast, in place, on the compositor, and the drawer takes the focus.",
    widths: [390],
    reducedMotion: "reduce",
    steps: [{ watchAnimations: true }, { tap: OPEN_MENU }, { wait: 400 }],
    assert: [
      { style: DRAWER, prop: "transition-duration", equals: `${FAST}, 0s` },
      { style: DRAWER, prop: "transition-property", equals: "opacity, visibility" },
      { style: `${DRAWER}[data-open="true"]`, prop: "translate", match: "^(none|0px)$" },
      { style: `${DRAWER}[data-open="true"]`, prop: "opacity", equals: "1" },
      { focused: DRAWER },
      { composited: ["opacity"] },
      { visible: `${DRAWER}[data-open="true"] nav` },
    ],
  }),
]

export default scenarios
