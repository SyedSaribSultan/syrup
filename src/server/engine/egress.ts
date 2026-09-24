import type { NetworkPolicy } from "@vercel/sandbox"
import { BASE_URL } from "../router/backends"
import { env } from "../env"

/**
 * Sandbox egress policy (docs/PHASE2.md S7).
 *
 * Two modes, chosen by the workspace's allow-list:
 * - Open (no hosts listed): the agent may reach the internet, but never
 *   private networks or the cloud metadata service. Nothing to configure and
 *   nothing breaks; this is the default.
 * - Strict (one or more hosts listed): only the hosts syrup itself needs
 *   (providers, git, package registries, the ingest endpoint) plus the
 *   workspace's own list. For people who want exfiltration limited.
 */

/** RFC1918, link-local (169.254.169.254 = cloud metadata), CGNAT. Loopback stays open for the sidecar. */
const PRIVATE_SUBNETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]

/** Hosts every workspace needs to boot and to run the agent at all. */
const BASE_HOSTS = [
  "opencode.ai",
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
]

const HOST = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i

/** Validates and normalises a user-supplied host list. Throws on anything that is not a hostname. */
export function normalizeHosts(input: string[]): string[] {
  const out = new Set<string>()
  for (const raw of input) {
    const h = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    if (!h) continue
    if (!HOST.test(h)) throw new Error(`"${raw}" is not a hostname (use e.g. api.example.com or *.example.com)`)
    out.add(h)
  }
  return [...out].slice(0, 50)
}

export function egressPolicy(providerIds: string[], extras: string[]): NetworkPolicy {
  if (extras.length === 0) return { subnets: { deny: PRIVATE_SUBNETS } }
  const providerHosts = providerIds.map((id) => BASE_URL[id]).filter(Boolean).map((u) => new URL(u).hostname)
  const ingest = new URL(env.appUrl).hostname
  const allow = [...new Set([...BASE_HOSTS, ...providerHosts, ingest, ...extras])]
  return { allow, subnets: { deny: PRIVATE_SUBNETS } }
}
