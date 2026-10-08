import { verifyIngestToken } from "@/server/cloud/ingest"
import { relayLookup } from "@/server/cloud/keys"
import { env } from "@/server/env"
import { slog } from "@/server/log"
import { BASE_URL } from "@/server/router/backends"
import { CatalogCache, catalogFromModelsDev } from "../../policy"
import { createRelay } from "../../relay"

/**
 * Cloud LLM relay: POST /api/ingest/llm/<provider>/chat/completions and
 * GET /api/ingest/llm/<provider>/models, called by the sandbox sidecar's router
 * with its ingest token as the bearer. The app adds the user's real key and
 * streams the provider's answer back; raw keys never enter the sandbox.
 * Logic and contract: ../../relay.ts; spend policy: ../../policy.ts.
 *
 * src/proxy.ts does not run here (its matcher leaves /api/ingest/llm/ out):
 * that would be a second function invocation on every model call, and a 4 MB
 * body cap under this route's 4.5 MB. This route is fail-closed on its own:
 * 404 outside the hosted version, and nothing is read before the token checks out.
 *
 * vercel.json turns on supportsCancellation for this route only, so a sidecar
 * that goes away (a hedge loser, a first-token timeout, Stop) aborts req.signal
 * and the provider call with it.
 */

export const dynamic = "force-dynamic"
/** Vercel Hobby with fluid compute: 300 s is both the default and the ceiling. It includes the time spent streaming. */
export const maxDuration = 300

/** The catalog OpenCode in the sandbox reads, loaded by the app itself: the sandbox's own copy is not trusted for spending. */
const MODELS_DEV = "https://models.dev/api.json"

const catalog = new CatalogCache(
  async () => {
    const res = await fetch(MODELS_DEV, { signal: AbortSignal.timeout(8_000), cache: "no-store" })
    if (!res.ok) throw new Error(`models.dev → ${res.status}`)
    return catalogFromModelsDev(await res.json(), Object.keys(BASE_URL))
  },
  { onError: (err) => slog("router", "relay.catalog_load_failed", { message: err instanceof Error ? err.message : String(err) }, { level: "warn" }) },
)

const relay = createRelay({
  verify: (token) => verifyIngestToken(token),
  lookup: relayLookup,
  catalog,
  baseURL: BASE_URL,
  // Ten seconds before Vercel would end the function: closing cleanly lets the router record the answer as truncated
  // and the engine continue, where a killed function would look like a broken stream.
  deadlineMs: (maxDuration - 10) * 1000,
  log: (event, data, level) => {
    // Spend on a paid key is also a plain runtime log line: it survives the function being cancelled mid-answer.
    if (event === "relay.paid_call" || event === "relay.paid_usage") console.info(`[syrup:router] ${event} ${JSON.stringify(data)}`)
    slog("router", event, data, { level: level ?? "info", directory: typeof data.workspaceId === "string" ? data.workspaceId : null })
  },
})

type Ctx = { params: Promise<{ provider: string; path: string[] }> }

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  if (!env.isCloud) return Response.json({ error: { type: "syrup_relay_not_found", message: "the relay exists in the hosted version only" } }, { status: 404 })
  const { provider, path } = await ctx.params
  return relay(req, provider, path)
}

export const GET = handle
export const POST = handle
