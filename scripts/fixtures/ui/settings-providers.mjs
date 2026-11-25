/**
 * Settings → Providers ("/settings/providers"): one card per provider, each a library card disclosure
 * (sarib-design v2.11, `s-disclosure--card`). The whole head is the expand button; opening one shows its
 * keys under a hairline. Nothing is saved: the key routes are never called.
 */
import { backgroundChats, defineScenario, WORKSPACE_FILES } from "./_kit.mjs"

const HEAD = ".s-disclosure--card > .s-disclosure__head > button.s-disclosure__trigger"

export default defineScenario({
  name: "settings-providers",
  description: "Providers settings: provider cards as library disclosures; one unconnected card opened.",
  route: "/settings/providers",
  chats: backgroundChats(),
  files: WORKSPACE_FILES,
  // A connected provider starts open, so open one that starts closed.
  steps: [{ click: `${HEAD}:has-text("OpenRouter")` }],
  assert: [
    { count: HEAD, min: 3 },
    { count: `${HEAD}[aria-expanded="true"]`, min: 1 },
    { visible: `.s-disclosure--card:has(button.s-disclosure__trigger:has-text("OpenRouter")) > .s-disclosure__panel` },
    // A closed card renders no panel at all.
    { count: `.s-disclosure--card:has(button.s-disclosure__trigger:has-text("Groq")) > .s-disclosure__panel`, max: 0 },
  ],
})
