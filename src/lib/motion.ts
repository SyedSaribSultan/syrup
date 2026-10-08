/**
 * Motion tokens (docs/MOTION.md §3): the one source of truth for timings.
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
  fast: 120,
  base: 180,
  slow: 240,
  shift: 4,
} as const

/** Easing curves, as CSS timing functions. */
export const ease = {
  /** entering: fast start, soft landing */
  arrive: "cubic-bezier(0.2, 0, 0, 1)",
  /** leaving: gets out of the way */
  leave: "cubic-bezier(0.3, 0, 1, 1)",
  /** changing size or place on screen */
  move: "cubic-bezier(0.2, 0, 0, 1)",
} as const
