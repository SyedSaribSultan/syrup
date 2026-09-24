import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { build } from "esbuild"

/**
 * Bundles the sidecar into one self-contained file the sandbox engine uploads
 * with writeFiles(). Runs before `next build` (see package.json "build").
 * Output: .sidecar/sidecar.js + .sidecar/sidecar.json { hash, builtAt }.
 */
mkdirSync(".sidecar", { recursive: true })
await build({
  entryPoints: ["sidecar/index.ts"],
  outfile: ".sidecar/sidecar.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: { js: "// syrup sidecar. Built from sidecar/index.ts; do not edit.\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
})
const js = readFileSync(".sidecar/sidecar.js")
const hash = createHash("sha256").update(js).digest("hex").slice(0, 16)
writeFileSync(".sidecar/sidecar.json", JSON.stringify({ hash, bytes: js.length, builtAt: new Date().toISOString() }))
console.log(`[sidecar] built .sidecar/sidecar.js (${(js.length / 1024).toFixed(0)} KB, ${hash})`)
