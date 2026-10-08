#!/usr/bin/env node
/**
 * Checks settledBlocks (src/lib/use-typewriter.ts): a streaming reply is cut into blocks that each render on their
 * own, so the cut must never change what the reply looks like. For every prefix of each sample below (what the text
 * is at some frame while it streams), rendering the blocks one by one must give the same HTML as rendering the
 * prefix whole, with the same Markdown plugins the chat uses. Since a finished streamed reply keeps its blocks, this
 * also covers the final render.
 *
 *   node scripts/fixtures/settled-blocks-check.mjs      # exit 0: every sample passes; 1: the first mismatch is printed
 *
 * Add a sample whenever the splitter gets a new rule or a reply renders differently while it streams.
 */
import { readFileSync } from "node:fs"
import { createRequire, stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const require = createRequire(path.join(ROOT, "package.json"))

// The module as it is, its imports stubbed (only settledBlocks runs here), its types stripped by Node itself.
const source = readFileSync(path.join(ROOT, "src", "lib", "use-typewriter.ts"), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/^"use client"$/m, "const createElement = () => null, useEffect = () => {}, useLayoutEffect = () => {}, useRef = () => ({}), useState = () => [], Markdown = null")
const { settledBlocks } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`)

const React = require("react")
const { renderToStaticMarkup } = require("react-dom/server")
const ReactMarkdown = (await import(pathToFileURL(require.resolve("react-markdown")).href)).default
const remarkGfm = (await import(pathToFileURL(require.resolve("remark-gfm")).href)).default
const html = (t) => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, t)).replace(/>\s+</g, "><").trim()

const SAMPLES = {
  plain: "Intro paragraph.\n\n## Heading\n\nSome text with `code`.\n\n- a\n- b\n\nAfter list.\n\n1. one\n2. two\n\n3. three\n\nEnd.\n",
  looseList: "- item one\n\n- item two\n\n  continued para in item two\n\nNot in the list.\n",
  fenceWithBlankLines: "Look:\n\n```python\nimport x\n\ndef f():\n    pass\n\nprint(1)\n```\n\nDone.\n",
  tableAndQuotes: "| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n> second quote\n\nText.\n",
  setextHeadings: "Para\n\nTitle\n=====\n\nMore\n---\n\nEnd\n",
  // A line starting with inline ```code``` is a paragraph, not a fence (CommonMark).
  inlineTripleAtLineStart: "```npm test``` runs the suite.\n\n```\nimport os\n\nprint(os.getcwd())\n```\n\nThat prints the folder.\n",
  backtickInfoWithBacktick: "```` x ` y\n\nPara\n\n````\ncode\n\nmore\n````\n\nEnd.\n",
  tildeFenceInsideBackticks: "Code:\n\n````md\n```js\nx\n\ny\n```\n````\n\nAfter.\n",
  fenceInListItem: "1. Install:\n   ```bash\n   npm i\n\n   npm test\n   ```\n2. Run it.\n\nDone.\n",
  thematicBreaks: "Above\n\n***\n\nBelow\n\n* * *\n\nEnd\n",
  // Raw HTML shows as text outside any paragraph: as a block of its own it would take block spacing.
  rawHtml: "Text\n\n<div>\nhi\n</div>\n\nMore text\n",
  autolinkLine: "<https://example.com>\n\nText\n\nMore\n",
  mathInline: "Energy $$E=mc^2$$ here.\n\n$$ x $$ trailing\n\nNext para\n\n```\na\n\nb\n```\n\nEnd.\n",
  mathBlock: "$$\nx\n\ny\n$$\n\nAfter.\n",
  referenceLink: "See [the docs][d].\n\nMore.\n\n[d]: https://example.com\n",
}

let failures = 0
for (const [name, text] of Object.entries(SAMPLES)) {
  let first = null
  for (let n = 1; n <= text.length && !first; n++) {
    const prefix = text.slice(0, n)
    const blocks = settledBlocks(prefix)
    if (blocks.join("") !== prefix) first = { n, why: "the blocks don't join back into the text" }
    else if (blocks.length > 1 && html(prefix) !== blocks.map(html).join("")) first = { n, why: `renders differently cut as ${JSON.stringify(blocks)}` }
  }
  if (first) {
    failures++
    console.log(`FAIL ${name} at ${first.n} characters: ${first.why}`)
  } else console.log(`ok   ${name}`)
}
console.log(failures ? `\n${failures} sample(s) render differently while streaming.` : "\nEvery prefix of every sample renders the same cut into blocks.")
process.exit(failures ? 1 : 0)
