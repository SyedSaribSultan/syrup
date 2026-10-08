#!/usr/bin/env node
/**
 * pnpm test:rich (docs/RENDERING.md §3.0): the rich-output unit tests. Only a runner: it bundles each
 * scripts/rich-tests/*.ts with esbuild (the @/ alias from tsconfig.json, like test-transcript.mjs), runs them in name
 * order and exits 1 on any failed check. A test file exports
 *
 *   default function (check: (ok: boolean, label: string, detail?: string) => void): void | Promise<void>
 *
 * and a package adds tests by adding a file there. export-dom.ts runs in Playwright's Chromium (no dev server).
 *
 *   node scripts/test-rich.mjs              every file
 *   node scripts/test-rich.mjs fence math   some files
 */
import { build } from "esbuild"
import { mkdirSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dir = path.join(root, "scripts", "rich-tests")
const outDir = path.join(root, "node_modules", ".cache", "syrup-rich-tests")
mkdirSync(outDir, { recursive: true })

const only = process.argv.slice(2)
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .filter((f) => !only.length || only.includes(f.replace(/\.ts$/, "")))
  .sort()

let passed = 0
let failed = 0
for (const f of files) {
  const outfile = path.join(outDir, f.replace(/\.ts$/, ".mjs"))
  await build({
    entryPoints: [path.join(dir, f)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    tsconfig: path.join(root, "tsconfig.json"),
    // Stylesheets imported by renderers mean nothing here.
    loader: { ".css": "empty" },
    // Playwright stays a real package (its browsers live outside the bundle).
    external: ["playwright", "playwright-core", "esbuild"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  })
  console.log(`\n${f}`)
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
  const t0 = Date.now()
  const check = (ok, label, detail = "") => {
    if (ok) passed++
    else failed++
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n       ${detail}` : ""}`)
  }
  try {
    await mod.default(check)
  } catch (err) {
    failed++
    console.log(`  FAIL ${f} threw: ${err instanceof Error ? err.stack : err}`)
  }
  console.log(`  (${Date.now() - t0} ms)`)
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
