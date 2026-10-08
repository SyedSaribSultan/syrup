import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { build } from "esbuild"

/**
 * Bundles what the engine needs next to it into self-contained files. Runs before `next build`
 * and `next dev` (see package.json). Output in .sidecar/:
 *   sidecar.js               the sandbox sidecar (router + memory MCP), uploaded with writeFiles()
 *   syrup-plugin.js          syrup's OpenCode plugin (src/server/engine/syrup-plugin.ts), loaded
 *                            by OpenCode in both modes (Bun runs it)
 *   prepare-config-dirs.js   the sandbox's config-dir preparation (src/server/engine/config-dirs.ts)
 *   sidecar.json             { hash, bytes, builtAt }: the hash covers all three files, so a reused
 *                            sandbox restarts onto a new plugin as it does onto a new sidecar
 */
mkdirSync(".sidecar", { recursive: true })
const common = { bundle: true, platform: "node", format: "esm", minify: false, sourcemap: false, legalComments: "none", logLevel: "warning" }
await Promise.all([
  build({
    ...common,
    entryPoints: ["sidecar/index.ts"],
    outfile: ".sidecar/sidecar.js",
    target: "node24",
    banner: { js: "// syrup sidecar. Built from sidecar/index.ts; do not edit.\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  }),
  // OpenCode's Bun imports this file and calls every function it exports: keep the entry's one export.
  build({ ...common, entryPoints: ["src/server/engine/syrup-plugin.ts"], outfile: ".sidecar/syrup-plugin.js", target: "node22", banner: { js: "// syrup's OpenCode plugin. Built from src/server/engine/syrup-plugin.ts; do not edit." } }),
  build({ ...common, entryPoints: ["sidecar/prepare-config-dirs.ts"], outfile: ".sidecar/prepare-config-dirs.js", target: "node22", banner: { js: "// syrup config-dir preparation. Built from src/server/engine/config-dirs.ts; do not edit." } }),
])
const files = ["sidecar.js", "syrup-plugin.js", "prepare-config-dirs.js"].map((f) => readFileSync(`.sidecar/${f}`))
const h = createHash("sha256")
for (const f of files) h.update(f)
const hash = h.digest("hex").slice(0, 16)
const bytes = files.reduce((n, f) => n + f.length, 0)
writeFileSync(".sidecar/sidecar.json", JSON.stringify({ hash, bytes, builtAt: new Date().toISOString() }))
console.log(`[sidecar] built .sidecar/ (sidecar ${(files[0].length / 1024).toFixed(0)} KB, plugin ${(files[1].length / 1024).toFixed(1)} KB, prepare ${(files[2].length / 1024).toFixed(1)} KB, ${hash})`)
