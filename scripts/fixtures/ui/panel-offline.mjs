/**
 * Round 2a review (2026-10-08): the panel's tabs load their own chunks (the Files tree, the file preview). When one
 * can't load (offline, or a tab left open across a deploy that renamed its chunks) the tab says so with Retry and
 * Reload; it used to throw and take the whole app down. The app's idle prefetch is off here ("syrup.prefetch"), so the
 * chunks are still unloaded when the page goes offline.
 *
 *   panel-offline-files     offline, then the panel opens on Files: the tab shows the note, the chat stays
 *   panel-offline-preview   the tree loads, then offline, then a file opens: the preview shows the note, the tree stays
 */
import { backgroundChats, chat, defineScenario, HOUR, text, WORKSPACE_FILES } from "./_kit.mjs"

const c = chat("Offline panel", { ago: 5 * HOUR })
c.user("Hi")
c.assistant([text("Reply MARKER-CHAT is here.", { ms: 2200 })])

const base = { route: c.route, chats: [c, ...backgroundChats()], files: WORKSPACE_FILES, storage: { "syrup.prefetch": "off" } }
const OPEN = { click: "button[title^='Show changes, files & preview'] >> visible=true" }
const NOTE = "[aria-label='Workspace panel'] [role=alert]"

const variants = [
  defineScenario({
    ...base,
    name: "panel-offline-files",
    description: "Offline, the panel opens on Files: the tab says it couldn't load, with Retry and Reload; the app stays.",
    steps: [{ offline: true }, OPEN, { waitFor: NOTE }],
    assert: [
      { text: "Couldn't load the file list." },
      { visible: "[aria-label='Workspace panel'] button:text-is('Retry')" },
      { visible: "[aria-label='Workspace panel'] button:text-is('Reload')" },
      { visible: "textarea", widths: [1440] },
      { text: "MARKER-CHAT", widths: [1440] },
    ],
  }),
  defineScenario({
    ...base,
    name: "panel-offline-preview",
    description: "The tree loads, then offline, then a file opens: the preview says it couldn't load; the tree and the app stay.",
    steps: [OPEN, { waitFor: "[aria-label='Workspace panel'] [role=treeitem][title='README.md']" }, { offline: true }, { click: "[aria-label='Workspace panel'] [role=treeitem][title='README.md']" }, { waitFor: NOTE }],
    assert: [{ text: "Couldn't load the file preview." }, { visible: "[aria-label='Workspace panel']" }, { visible: "textarea", widths: [1440] }, { text: "MARKER-CHAT", widths: [1440] }],
  }),
]

export default variants
