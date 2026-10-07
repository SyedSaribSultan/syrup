/**
 * The empty new-chat screen ("/"): heading, composer, the workspace it works in,
 * and a sidebar with a few earlier chats. No chat is open, nothing is streaming.
 */
import { backgroundChats, defineScenario, WORKSPACE, WORKSPACE_FILES } from "./_kit.mjs"

export default defineScenario({
  name: "new-chat",
  description: "Empty new-chat screen: heading, composer, workspace line, sidebar with earlier chats.",
  route: "/",
  chats: backgroundChats(),
  files: WORKSPACE_FILES,
  assert: [
    { visible: "h1:text-is('What are we building?')" },
    { visible: 'textarea[placeholder^="Ask syrup"]' },
    { visible: 'button[aria-label="Send"]' },
    { text: `Working in ${WORKSPACE}` },
    // The no-keys hint stays away: the fixture has a free Google key.
    { hidden: "text=No API keys yet." },
    // Desktop: the sidebar lists the workspace's chats (phones keep it in the closed drawer).
    { count: 'nav a[href^="/s/"]', min: 4, widths: [1440] },
  ],
})
