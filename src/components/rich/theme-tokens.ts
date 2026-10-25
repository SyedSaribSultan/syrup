import type { ThemeTokens } from "./types"

/**
 * The app's colours for pictures (docs/RENDERING.md §2.7). In the core chunk. readTokens() reads the page's computed
 * :root values at render time; LIGHT_TOKENS are the light values for the HTML export, which always draws light (a
 * dark page's tokens would draw dark pictures on the export's light card). test:rich checks them against globals.css (its roles resolved through sarib-tokens.css).
 */

export const LIGHT_TOKENS: Readonly<ThemeTokens> = Object.freeze({
  scheme: "light",
  font: '"Google Sans Flex", system-ui, sans-serif',
  mono: '"Google Sans Code", ui-monospace, monospace',
  ink: "#0f0e0c",
  ink2: "#605f5c",
  muted: "rgba(15, 14, 12, 0.5)",
  line: "#e4e4e1",
  line2: "#d4d3d0",
  surface: "#f7f7f4",
  surface2: "#ecebe8",
  accent: "#a70d00",
  accentSoft: "#ffebe4",
  ok: "#006429",
  warn: "#8c5500",
  err: "#9c0325",
  series: ["#3b73c4", "#3f9a5a", "#d19a1f", "#8a5bc9", "#d2493f", "#1f9a9a", "#cf4f95", "#9a6a3f"],
})

/** The tokens and the CSS custom property each one reads. */
export const TOKEN_VARS: Readonly<Record<Exclude<keyof ThemeTokens, "scheme" | "font" | "mono" | "series">, string>> = {
  ink: "--ink",
  ink2: "--ink-2",
  muted: "--muted",
  line: "--line",
  line2: "--line-2",
  surface: "--surface",
  surface2: "--surface-2",
  accent: "--accent",
  accentSoft: "--accent-soft",
  ok: "--ok",
  warn: "--warn",
  err: "--err",
}

/** The current page's values (computed, so data-theme and the media query both count). */
export function readTokens(scheme: "light" | "dark"): ThemeTokens {
  if (typeof document === "undefined") return { ...LIGHT_TOKENS, scheme }
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  const out = { ...LIGHT_TOKENS, scheme, series: LIGHT_TOKENS.series.map((c, i) => v(`--ws-${i}`, c)) } as ThemeTokens
  for (const [k, name] of Object.entries(TOKEN_VARS)) (out as unknown as Record<string, string>)[k] = v(name, (LIGHT_TOKENS as unknown as Record<string, string>)[k])
  out.font = getComputedStyle(document.body).fontFamily || LIGHT_TOKENS.font
  return out
}
