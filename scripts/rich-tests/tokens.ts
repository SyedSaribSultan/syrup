/** LIGHT_TOKENS (docs/RENDERING.md §2.7) equal the light :root block of src/app/globals.css, so the export draws in the app's colours. */
import { readFileSync } from "node:fs"
import path from "node:path"
import { LIGHT_TOKENS, TOKEN_VARS } from "@/components/rich/theme-tokens"

type Check = (ok: boolean, label: string, detail?: string) => void

export default function run(check: Check) {
  const css = readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8")
  // The first plain :root block is the light theme (dark ones sit in a media query or carry [data-theme]).
  const block = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
  const vars = new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]))
  check(vars.size > 10, `read the light :root block (${vars.size} variables)`)
  for (const [key, name] of Object.entries(TOKEN_VARS)) {
    const want = vars.get(name)
    const got = (LIGHT_TOKENS as unknown as Record<string, string>)[key]
    check(want === got.toLowerCase(), `LIGHT_TOKENS.${key} = ${name}`, `${got} vs ${want}`)
  }
  LIGHT_TOKENS.series.forEach((c, i) => check(vars.get(`--ws-${i}`) === c.toLowerCase(), `LIGHT_TOKENS.series[${i}] = --ws-${i}`, `${c} vs ${vars.get(`--ws-${i}`)}`))
  check(LIGHT_TOKENS.scheme === "light", "LIGHT_TOKENS are the light scheme")
}
