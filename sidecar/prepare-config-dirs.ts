import { prepareConfigDirs } from "../src/server/engine/config-dirs"

/**
 * The sandbox side of the config-dir preparation (src/server/engine/config-dirs.ts), bundled by
 * sidecar/build.mjs into .sidecar/prepare-config-dirs.js and run right before `opencode serve`:
 *
 *   node prepare-config-dirs.js --create /vercel/.config/opencode --existing /vercel/.opencode
 *
 * Prints one JSON line with what it did. Always exits 0: a failure costs the plugin install
 * wait, never the engine start.
 */
const args = process.argv.slice(2)
const dirs: { dir: string; create: boolean }[] = []
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--create" || args[i] === "--existing") && args[i + 1]) dirs.push({ dir: args[++i], create: args[i - 1] === "--create" })
}
try {
  console.log(JSON.stringify({ prepareConfigDirs: prepareConfigDirs(dirs) }))
} catch (err) {
  console.log(JSON.stringify({ prepareConfigDirs: "failed", error: String(err) }))
}
