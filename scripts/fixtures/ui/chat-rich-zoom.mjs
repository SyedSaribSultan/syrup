/**
 * Round 2a (docs/RENDERING.md §2.8): a diagram in the chat opens at full size in the panel, by a click on desktop and
 * a tap on a phone (the full-screen layer there), with Fit · 100% · 200%.
 */
import { backgroundChats, defineScenario, WORKSPACE_FILES } from "./_kit.mjs"
import { RICH_CHAT } from "./chat-rich-fences.mjs"

const FIRST = ".chat-log figure[data-rich-kind=mermaid][data-rich-state=ready] .rich-clip >> nth=0"

export default defineScenario({
  name: "chat-rich-zoom",
  description: "Click or tap the first diagram: it opens in the panel at full size, with Fit · 100% · 200%.",
  route: RICH_CHAT.route,
  chats: [RICH_CHAT, ...backgroundChats()],
  files: WORKSPACE_FILES,
  steps: [
    { click: FIRST, widths: [1440] },
    { tap: FIRST, widths: [390] },
    { waitFor: "[aria-label='Workspace panel'] button:text-is('Fit')" },
    { settle: true },
  ],
  assert: [
    { visible: "[aria-label='Workspace panel'] figure[data-rich-kind=mermaid][data-rich-state=ready]" },
    { visible: "[aria-label='Workspace panel'] button:text-is('Fit')" },
    { text: "Preview · Diagram", widths: [1440] },
  ],
})
