/**
 * Loads src/lib/answer-checks (TypeScript) for the scripts: esbuild bundles it in memory and Node
 * imports the result from a data: URL. Nothing is written to disk, nothing new is installed.
 * The library has no imports outside its folder, so the bundle is exactly what the UI will run.
 */
import { build } from "esbuild"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

export async function loadChecks() {
  const res = await build({
    entryPoints: [path.join(ROOT, "src", "lib", "answer-checks", "index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "warning",
  })
  const code = res.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)
}
