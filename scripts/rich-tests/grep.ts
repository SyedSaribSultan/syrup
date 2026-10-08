/**
 * One mount point for markup (docs/RENDERING.md §2.12): under src/components/rich/, only shadow-markup.tsx and the
 * math renderer may set HTML. Any other innerHTML, outerHTML, insertAdjacentHTML or dangerouslySetInnerHTML fails.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

type Check = (ok: boolean, label: string, detail?: string) => void

const ALLOWED = new Set(["shadow-markup.tsx", "renderers/math.tsx"])

export default function run(check: Check) {
  const dir = path.join(process.cwd(), "src", "components", "rich")
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(n)) files.push(p)
    }
  }
  walk(dir)
  const hits: string[] = []
  for (const f of files) {
    const rel = path.relative(dir, f).split(path.sep).join("/")
    if (ALLOWED.has(rel)) continue
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML)\b/.test(line) && !/^\s*(\*|\/\/)/.test(line)) hits.push(`${rel}:${i + 1}`)
      })
  }
  check(files.length > 5, `scanned src/components/rich (${files.length} files)`)
  check(hits.length === 0, "no HTML is set outside shadow-markup.tsx and renderers/math.tsx", hits.join(", "))
}
