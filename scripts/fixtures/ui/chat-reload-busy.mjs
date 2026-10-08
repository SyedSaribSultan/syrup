/**
 * A reload in the middle of a turn that waits for the user. OpenCode 1.18's event stream replays
 * nothing when it opens, so the page must ask: GET /session/status (busy: the composer offers
 * Stop), GET /permission and GET /question (the card the agent is waiting on). This harness, like
 * the engine, sends neither the busy status nor the request over the stream, so everything below
 * comes from those reads: on the first load, and again after a reload.
 *
 *   chat-reload-busy           the agent waits for permission to run `git push`
 *   chat-reload-question       the agent asked which branch to use
 */
import { backgroundChats, bashResult, chat, defineScenario, SEC, text, tool, WORKSPACE_FILES } from "./_kit.mjs"

function busyChat(title, ask) {
  const c = chat(title, { ago: 0 })
  c.user("Commit the cart fix and push it so the preview deploy picks it up.")
  c.assistant([
    tool("bash", { command: "git status --short", description: "Show changed files" }, { ...bashResult(" M src/cart.ts\n?? src/money.ts\n"), ms: 300 }),
    tool("bash", { command: "git add src/cart.ts src/money.ts && git commit -m \"Cart totals in integer cents\"", description: "Commit the fix" }, { ...bashResult("[main 4f2c1d9] Cart totals in integer cents\n 2 files changed, 18 insertions(+), 4 deletions(-)\n"), ms: 600 }),
    text("Committed. Pushing to `main` now.", { ms: 900 }),
  ])
  // The step that waits: its tool is running until the user answers.
  c.assistant([ask], { open: true })
  return c
}

const push = busyChat("Push the cart fix", tool("bash", { command: "git push origin main", description: "Push to GitHub" }, { status: "running", ms: 25 * SEC }))
const which = busyChat("Push the cart fix to a branch", tool("question", { questions: [] }, { status: "running", ms: 40 * SEC }))

/** Names the waiting tool call in each pending request (`tool`), as the engine does. */
function linkCall(scenario) {
  for (const req of [...(scenario.engine.permissions ?? []), ...(scenario.engine.questions ?? [])]) {
    const msg = scenario.engine.messages[req.sessionID].at(-1)
    const call = msg.parts.find((p) => p.type === "tool")
    req.tool = { messageID: msg.info.id, callID: call.callID }
  }
  return scenario
}

const steps = (card) => [
  { assert: { visible: "button:text-is('Stop')" } },
  { assert: { visible: card } },
  { reload: true },
  { settle: true },
]

const variants = [
  linkCall(defineScenario({
    name: "chat-reload-busy",
    description: "Reload while the agent waits for permission to run git push: Stop and the permission card come back from the engine's state.",
    route: push.route,
    chats: [push, ...backgroundChats()],
    files: WORKSPACE_FILES,
    engine: {
      permissions: [{ id: "per_d0c4e1f2a001harnessPush1", sessionID: push.id, permission: "bash", patterns: ["git push origin main"], metadata: { command: "git push origin main" }, always: ["git push *"] }],
    },
    steps: steps("text=Allow bash?"),
    assert: [
      { visible: "button:text-is('Stop')" },
      { visible: "text=Allow bash?" },
      { text: "git push origin main" },
      { visible: "button:text-is('Allow once')" },
      { visible: ".chat-log [role=status]:has-text('Running')" },
    ],
  }),
  ),
  linkCall(defineScenario({
    name: "chat-reload-question",
    description: "Reload while the agent waits for an answer to its question: Stop and the question card come back from the engine's state.",
    route: which.route,
    chats: [which, ...backgroundChats()],
    files: WORKSPACE_FILES,
    engine: {
      questions: [
        {
          id: "que_d0c4e1f2a001harnessWhich",
          sessionID: which.id,
          questions: [
            {
              header: "Branch",
              question: "Push to main, or to a new branch for a pull request?",
              options: [
                { label: "main", description: "Deploys to production right away" },
                { label: "cart-cents", description: "A new branch; I'll open a pull request" },
              ],
            },
          ],
        },
      ],
    },
    steps: steps("text=Push to main, or to a new branch for a pull request?"),
    assert: [
      { visible: "button:text-is('Stop')" },
      { visible: "text=Push to main, or to a new branch for a pull request?" },
      { visible: "button:has-text('cart-cents')" },
      { visible: "button:text-is('Skip')" },
    ],
  }),
  ),
]

export default variants
