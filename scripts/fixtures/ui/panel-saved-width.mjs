/**
 * The desktop side pane with a width saved on a bigger monitor. A pane left 1100 px wide on a
 * 1920 px screen used to leave the chat 96 px on a 1440 px laptop (its only cap was 75% of the
 * window). The chat keeps 440 px (docs/RESPONSIVE.md §6): the saved width is clamped when the
 * pane opens, when the window resizes and while it is dragged, and stays saved as it was, so
 * the big monitor gets its wide pane back.
 */
import { backgroundChats, chat, defineScenario, HOUR, text, WORKSPACE_FILES } from "./_kit.mjs"

const c = chat("Draft the launch plan", { ago: 5 * HOUR })
c.user("What's left before the launch? Check docs/launch-plan.md.")
c.assistant([text("Four things are open: Stripe live keys and the webhook, Apple Pay domain verification, EU and UK shipping rates, and the launch email with the social posts. Payments are the long pole: Maya owns them and they're due on 14 October.", { ms: 2400 })])

const PANE = "[aria-label='Workspace panel']"
// 1440 minus the 264 px sidebar leaves a 1176 px row: the pane gets 736 px, the chat its 440 px.
const CHAT_MIN = 439

export default defineScenario({
  name: "panel-saved-width",
  description: "Side pane saved 1100 px wide on a 1920 px monitor, opened at 1440 px: the chat keeps 440 px (on open, resize and drag). Phones: the full-screen layer.",
  route: c.route,
  chats: [c, ...backgroundChats()],
  files: WORKSPACE_FILES,
  panelPrefs: { width: 1100 },
  panel: { tab: "files" },
  steps: [
    { assert: { box: ".chat-log", minWidth: CHAT_MIN }, widths: [1440] },
    // At the 440 px floor the title keeps room to read: the token totals step aside while the pane is open.
    { assert: { box: "header h1", minWidth: 140 }, widths: [1440] },
    { assert: { hidden: "header :text('tokens ·')" }, widths: [1440] },
    { assert: { box: PANE, maxWidth: 740 }, widths: [1440] },
    // On the big monitor the pane is as wide as it was left there.
    { resize: [1920, 900], widths: [1440] },
    { settle: true, widths: [1440] },
    { assert: { box: PANE, minWidth: 1099, maxWidth: 1101 }, widths: [1440] },
    // Back on the laptop, clamped again.
    { resize: [1440, 900], widths: [1440] },
    { settle: true, widths: [1440] },
    { assert: { box: ".chat-log", minWidth: CHAT_MIN }, widths: [1440] },
    // Dragging the edge further left stops where the chat would get narrower than 440 px.
    { drag: [`${PANE} [role=separator]`, -400], widths: [1440] },
    { settle: true, widths: [1440] },
    { assert: { box: ".chat-log", minWidth: CHAT_MIN }, widths: [1440] },
  ],
  assert: [
    { box: ".chat-log", minWidth: CHAT_MIN, widths: [1440] },
    { box: PANE, minWidth: 700, maxWidth: 740, widths: [1440] },
    // A phone shows the panel as a full-screen layer, whatever width the desktop saved.
    { box: PANE, minWidth: 389, widths: [390] },
    { visible: `${PANE} [role=treeitem][title='docs']` },
    { text: "Four things are open" },
  ],
})
