/**
 * Is the sidecar running in a reused ("hot") sandbox the one this deployment
 * ships? A sandbox outlives deploys for up to a session (45 min), and its
 * sidecar keeps whatever protocol and environment it was started with: before
 * the LLM relay, provider keys in its env and direct provider calls. The sidecar
 * reports its bundle hash on /health (SYRUP_SIDECAR_BUNDLE); a hot sandbox whose
 * sidecar reports another one, or none, or does not answer, is restarted.
 *
 * Pure (scripts/test-llm-proxy.mjs bundles it).
 */

/** The `curl` result for the sidecar's /health → whether to restart. Null (the check itself failed) never restarts. */
export function sidecarStale(answer: { exitCode: number; stdout: string } | null, hash: string): boolean {
  if (!answer) return false
  if (answer.exitCode !== 0) return true
  try {
    const j = JSON.parse(answer.stdout) as { bundle?: unknown }
    return j.bundle !== hash
  } catch {
    return true
  }
}

/**
 * Kills a sandbox's sidecar and OpenCode before they are started again, so the
 * new sidecar can take its port. Matches on /proc command lines; the patterns
 * are written so this script's own command line (which contains them) never
 * matches, and the shell's own pid is skipped as well.
 */
export const STOP_ENGINE_SCRIPT = [
  "for d in /proc/[0-9]*; do",
  '  p="${d#/proc/}"; [ "$p" = "$$" ] && continue',
  "  c=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null) || continue",
  '  case "$c" in *sidecar[.]js*|*opencod[e]\\ serve*) kill -9 "$p" 2>/dev/null ;; esac',
  "done",
  "sleep 0.3",
  "true",
].join("\n")
