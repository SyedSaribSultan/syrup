import type { Catalog, CatalogModel } from "./store"

/**
 * Catalog normalisation shared by both router stores. OpenCode's provider
 * list and raw models.dev disagree on field names (capabilities.toolcall vs
 * tool_call, capabilities.interleaved vs interleaved, input modalities vs
 * attachment). Everything downstream (the model registry, the router) reads
 * `capabilities`, so fill it from whichever shape arrived.
 */

type Raw = CatalogModel & { capabilities?: CatalogModel["capabilities"] & Record<string, unknown> }

export function normalizeModel(raw: Raw): CatalogModel {
  const caps = raw.capabilities ?? {}
  const image = caps.input?.image ?? (Array.isArray(raw.modalities?.input) ? raw.modalities.input.includes("image") : raw.attachment)
  return {
    ...raw,
    capabilities: {
      ...caps,
      toolcall: caps.toolcall ?? raw.tool_call,
      reasoning: caps.reasoning ?? raw.reasoning,
      input: { ...caps.input, image: !!image },
      interleaved: caps.interleaved ?? raw.interleaved ?? false,
    },
  }
}

/** provider list (OpenCode `all`) → Catalog, with every model normalised. */
export function catalogFrom(providers: { id: string; models: Record<string, unknown> }[]): Catalog {
  const out: Catalog = new Map()
  for (const p of providers) {
    const models = new Map<string, CatalogModel>()
    for (const m of Object.values(p.models ?? {}) as Raw[]) {
      if (m && typeof m.id === "string") models.set(m.id, normalizeModel(m))
    }
    out.set(p.id, models)
  }
  return out
}
