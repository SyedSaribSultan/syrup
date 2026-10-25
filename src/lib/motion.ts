/**
 * Motion tokens (docs/MOTION.md §3): the one source of truth for timings.
 * Values are the Sarib design system's (sarib-design tokens.css): fast 150 / base 250 / slow 420 ms; arrive and move on
 * --s-motion-easing-standard, leave on --s-motion-easing-exit.
 *
 * src/app/globals.css mirrors these in `:root` as --motion-* and --ease-*; scripts/check-motion.mjs (part of
 * `pnpm lint`) fails when the two disagree. Components use the CSS side (a plain `transition`, or a `motion-*`
 * utility). JS reads these only where it must time something itself, e.g. a fallback timeout for an exit that
 * fires no transitionend (a 0 ms duration under reduced motion fires none).
 *
 * Exits are one step faster than entrances: slow → base, base → fast.
 */

/** Durations in milliseconds, and how far popovers and notices travel in px (0 under reduced motion, in CSS). */
export const motion = {
  fast: 150,
  base: 250,
  slow: 420,
  shift: 4,
} as const

/** Easing curves: the design system's own tokens (CSS only; JS never animates with these strings). */
export const ease = {
  /** entering: fast start, soft landing */
  arrive: "var(--s-motion-easing-standard)",
  /** leaving: gets out of the way */
  leave: "var(--s-motion-easing-exit)",
  /** changing size or place on screen */
  move: "var(--s-motion-easing-standard)",
} as const
