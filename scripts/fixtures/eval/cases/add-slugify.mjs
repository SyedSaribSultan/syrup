import { checks as c, defineCase } from "../../../eval/kit.mjs"

/** A small function from a written spec, checked by hidden tests (edge cases the prompt implies but doesn't list). */
export default defineCase({
  id: "add-slugify",
  title: "Add slugify() from a spec (coding, hidden tests)",
  tags: ["smoke", "coding"],
  workspace: "workspaces/add-slugify",
  turns: [
    "Add a function slugify(text) to text_utils.py. It lower-cases the text, keeps ASCII letters and digits, turns every run of any other characters into a single hyphen, and never starts or ends with a hyphen. Example: slugify('  Hello, World! 2026 ') == 'hello-world-2026'. Keep title_case as it is.",
  ],
  checks: [c.answered(), c.hiddenTests({ cmd: ["python", "-m", "unittest", "discover", "-p", "test_*.py"] })],
})
