import { checks as c, defineCase } from "../../../eval/kit.mjs"

/** Two bugs, a failing visible test file, and hidden tests the agent never sees (run after it finishes). */
export default defineCase({
  id: "fix-failing-test",
  title: "Fix util.py so its tests pass (coding, hidden tests)",
  tags: ["smoke", "coding"],
  workspace: "workspaces/fix-failing-test",
  turns: ["The tests in test_util.py fail. Fix util.py so they pass. Don't change the tests."],
  checks: [
    c.answered(),
    c.untouched(["test_util.py"]),
    c.hiddenTests({ cmd: ["python", "-m", "unittest", "discover", "-p", "test_*.py"] }),
  ],
})
