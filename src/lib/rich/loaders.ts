import type { RendererModule } from "@/components/rich/types"
import { FILE_RENDERERS } from "@/components/rich/file-loaders"
import type { RichKind } from "./kinds"

/**
 * The chat's renderers (lane A): one literal import() per kind, so each is its own chunk, loaded on first use
 * (docs/RENDERING.md §2.2). Panel-only kinds live in FILE_RENDERERS (lane C). A kind is drawn when either map has it.
 */
export const CHAT_RENDERERS: Partial<Record<RichKind, () => Promise<RendererModule>>> = {
  mermaid: () => import("@/components/rich/renderers/mermaid"),
  svg: () => import("@/components/rich/renderers/svg"),
}

export function loadRenderer(kind: RichKind): (() => Promise<RendererModule>) | null {
  return CHAT_RENDERERS[kind] ?? FILE_RENDERERS[kind] ?? null
}

export function enabled(kind: RichKind): boolean {
  return loadRenderer(kind) !== null
}
