#!/usr/bin/env node
/**
 * Screenshot sweep for the responsive work (docs/RESPONSIVE.md §11). Opens each
 * route at every device width and saves what the viewer would see, so layout
 * changes can be compared width by width.
 *
 *   pnpm dev                                   # in another terminal
 *   pnpm shots                                 # default routes → screenshots/latest/
 *   pnpm shots -- --label before /s/abc /usage # own routes and folder name
 *
 * The route "@chat" means the first chat in the sidebar, whatever its id.
 *
 * Phones and tablets are emulated as touch devices, so pointer-coarse styles
 * apply. Emulation can't reproduce the iOS keyboard, safe areas or Safari's
 * toolbars; those need a real phone. Also flags any page that scrolls
 * sideways, which the layout should never do.
 *
 * Env: SHOTS_BASE (default http://127.0.0.1:3000).
 */
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const base = (process.env.SHOTS_BASE ?? "http://127.0.0.1:3000").replace(/\/$/, "")

const DEVICES = [
  { name: "phone-360", width: 360, height: 780, touch: true },
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "phone-430", width: 430, height: 932, touch: true },
  { name: "tablet-744", width: 744, height: 1133, touch: true },
  { name: "tablet-820", width: 820, height: 1180, touch: true },
  { name: "tablet-1024", width: 1024, height: 768, touch: true },
  { name: "tablet-1180", width: 1180, height: 820, touch: true },
  { name: "desktop-1280", width: 1280, height: 800, touch: false },
  { name: "desktop-1440", width: 1440, height: 900, touch: false },
  { name: "desktop-1920", width: 1920, height: 1080, touch: false },
]
const DEFAULT_ROUTES = ["/", "@chat", "/settings/providers", "/usage", "/skills", "/memory"]

const args = process.argv.slice(2).filter((a) => a !== "--")
let label = "latest"
const routes = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--label") label = args[++i] ?? label
  else routes.push(args[i].startsWith("/") || args[i].startsWith("@") ? args[i] : `/${args[i]}`)
}
if (!routes.length) routes.push(...DEFAULT_ROUTES)

const outDir = path.join(root, "screenshots", label)
mkdirSync(outDir, { recursive: true })
const slug = (route) => (route === "/" ? "home" : /\/s\//.test(route) ? "chat" : route.replace(/^\//, "").replace(/[^\w-]+/g, "_"))

try {
  const r = await fetch(base, { redirect: "manual" })
  if (r.status >= 500) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`Can't reach ${base} (${e.message}). Start the app first: pnpm dev`)
  process.exit(1)
}

const browser = await chromium.launch()

if (routes.includes("@chat")) {
  const page = await browser.newPage()
  await page.goto(base + "/", { waitUntil: "load" })
  const href = await page
    .locator('nav a[href*="/s/"]')
    .first()
    .getAttribute("href", { timeout: 10000 })
    .catch(() => null)
  await page.close()
  routes.splice(routes.indexOf("@chat"), 1, ...(href ? [href] : []))
  if (!href) console.log("No chat in the sidebar yet; skipping @chat.")
}
const wide = []
let count = 0
try {
  for (const d of DEVICES) {
    const context = await browser.newContext({
      viewport: { width: d.width, height: d.height },
      hasTouch: d.touch,
      isMobile: d.touch,
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    for (const route of routes) {
      await page.goto(base + route, { waitUntil: "load" })
      // Live streams keep the network busy, so wait a fixed beat for data and fonts instead of networkidle.
      await page.waitForTimeout(1500)
      const file = path.join(outDir, `${slug(route)}@${d.name}.png`)
      await page.screenshot({ path: file })
      count++
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) wide.push(`${route} @ ${d.name}: ${overflow}px too wide`)
    }
    await context.close()
  }
} finally {
  await browser.close()
}

console.log(`${count} screenshots → ${path.relative(root, outDir)}`)
if (wide.length) console.log(`Pages that scroll sideways:\n  ${wide.join("\n  ")}`)
