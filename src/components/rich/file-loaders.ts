import type { RichKind } from "@/lib/rich/kinds"
import type { RendererModule } from "./types"

/**
 * Panel-only renderers and previews (lane C, docs/RENDERING.md §2.2): Excalidraw, maps, notebooks and the HTML/React
 * preview arrive here from Round 4 on, one literal import() per kind. Empty in Round 2a.
 */
export const FILE_RENDERERS: Partial<Record<RichKind, () => Promise<RendererModule>>> = {}
