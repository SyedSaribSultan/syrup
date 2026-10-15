import type { NetworkPolicy } from "@vercel/sandbox"
import { FX_HOSTS } from "../calc/fx"
import { BASE_URL } from "../router/backends"
import { env } from "../env"
import { UserError } from "../user-error"

/**
 * Sandbox egress policy (docs/PHASE2.md S7).
 *
 * Two modes, chosen by the workspace's allow-list:
 * - Strict (the default, audit 2026-10-15 M1): only the hosts syrup itself needs (git, package registries, the
 *   engine's own services, the ingest endpoint) plus any hosts the workspace lists. A prompt-injected agent cannot
 *   send the workspace anywhere else.
 * - Open (the list holds OPEN_INTERNET, "*"): the agent may reach the internet. An explicit opt-in per workspace.
 * Private networks and the cloud metadata service are denied in both.
 */

/** The allow-list entry that opts a workspace into open internet. */
export const OPEN_INTERNET = "*"

/** True when the workspace opted into open internet. */
export function isOpen(hosts: string[]): boolean {
  return hosts.includes(OPEN_INTERNET)
}

/** RFC1918, link-local (169.254.169.254 = cloud metadata), CGNAT. Loopback stays open for the sidecar. */
const PRIVATE_SUBNETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]

/** Hosts every workspace needs to boot and to run the agent at all. */
const BASE_HOSTS = [
  "opencode.ai",
  "mcp.exa.ai",
  "models.dev",
  "github.com",
  "api.github.com",
  "*.githubusercontent.com",
  "codeload.github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "storage.googleapis.com",
  // syrup_calc's exchange rates (src/server/calc/fx.ts): the MCP server runs in the sidecar, inside the sandbox.
  ...FX_HOSTS,
]

const HOST = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i

/** Validates and normalises a user-supplied host list. Throws on anything that is not a hostname. */
export function normalizeHosts(input: string[]): string[] {
  const out = new Set<string>()
  for (const raw of input) {
    const h = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    if (!h) continue
    if (h === OPEN_INTERNET) {
      out.add(h)
      continue
    }
    if (!HOST.test(h)) throw new UserError(`"${raw}" is not a hostname (use e.g. api.example.com or *.example.com)`)
    out.add(h)
  }
  return [...out].slice(0, 50)
}

export function egressPolicy(providerIds: string[], extras: string[]): NetworkPolicy {
  // `subnets` alone denies every domain (verified 2026-09-24); the explicit wildcard keeps the internet open.
  if (isOpen(extras)) return { allow: ["*"], subnets: { deny: PRIVATE_SUBNETS } }
  const providerHosts = providerIds.map((id) => BASE_URL[id]).filter(Boolean).map((u) => new URL(u).hostname)
  const ingest = new URL(env.appUrl).hostname
  const allow = [...new Set([...BASE_HOSTS, ...providerHosts, ingest, ...extras])]
  return { allow, subnets: { deny: PRIVATE_SUBNETS } }
}
