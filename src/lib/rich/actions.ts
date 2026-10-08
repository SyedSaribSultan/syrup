import type { Connection } from "@/lib/oc"
import type { RichInput } from "@/components/rich/types"
import type { RichKind } from "./kinds"

/**
 * Block actions ("Edit as drawing", "Try to fix"): registered here so a later round adds one without editing the core
 * (docs/RENDERING.md §2.2). The toolbar lists the actions whose `when` holds.
 */

export interface ActionEnv {
  readOnly: boolean
  engine: { directory: string; connection: Connection | null } | null
  panel: { openFile(path: string): void; openBlock(input: RichInput): void } | null
}

export interface BlockAction {
  id: string
  label: string
  kinds: RichKind[]
  when(i: RichInput, env: ActionEnv): boolean
  run(i: RichInput, env: ActionEnv): Promise<void>
  prefetch?(): void
}

const actions: BlockAction[] = []

export function registerBlockAction(a: BlockAction): void {
  const i = actions.findIndex((x) => x.id === a.id)
  if (i >= 0) actions[i] = a
  else actions.push(a)
}

export function blockActions(i: RichInput, env: ActionEnv): BlockAction[] {
  return actions.filter((a) => a.kinds.includes(i.kind) && a.when(i, env))
}
