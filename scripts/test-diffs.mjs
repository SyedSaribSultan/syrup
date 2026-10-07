#!/usr/bin/env node
/**
 * Checks the Changes panel's diff merging (src/lib/diffs.ts) against the shape
 * OpenCode 1.18 really sends: a full-context unified `patch` per file, per user
 * turn. Bundles the module with esbuild like scripts/test-router.mjs.
 *
 *   node scripts/test-diffs.mjs
 */
import { build } from "esbuild"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "node_modules", ".cache", "syrup-diffs-test")
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, "diffs.mjs")
await build({ entryPoints: [path.join(root, "src/lib/diffs.ts")], outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" })
const { sides, mergeTurns, turnsSignature } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : err}`)
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`)
}

// Exactly what the engine returned for the write-tool test session (hello.txt created, no trailing newline).
const added = {
  file: "hello.txt",
  patch: "Index: hello.txt\n===================================================================\n--- hello.txt\t\n+++ hello.txt\t\n@@ -0,0 +1,1 @@\n+hello\n\\ No newline at end of file\n",
  additions: 1,
  deletions: 0,
  status: "added",
}

check("a) an added file rebuilds to empty before and the new text after", () => {
  eq(sides(added), { before: "", after: "hello" }, "sides")
})

check("b) a full-context patch keeps unchanged lines on both sides, in order", () => {
  const d = { file: "a.ts", additions: 1, deletions: 1, patch: "--- a.ts\n+++ a.ts\n@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 3\n const c = 4\n" }
  eq(sides(d), { before: "const a = 1\nconst b = 2\nconst c = 4", after: "const a = 1\nconst b = 3\nconst c = 4" }, "sides")
})

check("c) older engines' before/after text is used as is", () => {
  eq(sides({ file: "x", additions: 0, deletions: 0, before: "old", after: "new" }), { before: "old", after: "new" }, "sides")
})

check("d) one turn merges to the engine's own counts", () => {
  const out = mergeTurns([[added]])
  eq(out.length, 1, "files")
  eq([out[0].file, out[0].additions, out[0].deletions, out[0].before, out[0].after], ["hello.txt", 1, 0, "", "hello"], "merged")
})

check("e) a file edited in two turns is counted once, first-before against last-after", () => {
  const t1 = { file: "a.ts", additions: 1, deletions: 1, patch: "--- a\n+++ a\n@@ -1,2 +1,2 @@\n-x = 1\n+x = 2\n y = 0\n" }
  const t2 = { file: "a.ts", additions: 1, deletions: 1, patch: "--- a\n+++ a\n@@ -1,2 +1,2 @@\n-x = 2\n+x = 3\n y = 0\n" }
  const out = mergeTurns([[t1], [t2]])
  eq(out.length, 1, "files")
  eq([out[0].before, out[0].after, out[0].additions, out[0].deletions], ["x = 1\ny = 0", "x = 3\ny = 0", 1, 1], "merged")
})

check("f) a file changed and then put back disappears", () => {
  const t1 = { file: "a.ts", additions: 1, deletions: 1, patch: "--- a\n+++ a\n@@ -1,1 +1,1 @@\n-x = 1\n+x = 2\n" }
  const t2 = { file: "a.ts", additions: 1, deletions: 1, patch: "--- a\n+++ a\n@@ -1,1 +1,1 @@\n-x = 2\n+x = 1\n" }
  eq(mergeTurns([[t1], [t2]]), [], "merged")
})

check("g) a file created in one turn and deleted in the next disappears; others stay", () => {
  const t1 = [added, { file: "b.txt", additions: 1, deletions: 0, patch: "--- b\n+++ b\n@@ -0,0 +1,1 @@\n+keep\n" }]
  const t2 = [{ file: "hello.txt", additions: 0, deletions: 1, status: "deleted", patch: "--- hello.txt\n+++ hello.txt\n@@ -1,1 +0,0 @@\n-hello\n" }]
  const out = mergeTurns([t1, t2])
  eq(out.map((d) => d.file), ["b.txt"], "files")
})

check("h) the signature changes when a summary changes and not otherwise", () => {
  const s1 = turnsSignature([[added]])
  const s2 = turnsSignature([[{ ...added }]])
  const s3 = turnsSignature([[{ ...added, additions: 2 }]])
  if (s1 !== s2) throw new Error("same content gave different signatures")
  if (s1 === s3) throw new Error("different content gave the same signature")
})

console.log(failed ? `\n${failed} check(s) failed` : "\nall diff checks passed")
process.exit(failed ? 1 : 0)
