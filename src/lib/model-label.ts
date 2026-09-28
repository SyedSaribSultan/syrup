import { displayName, providerName } from "./model-registry"
import { routerSwitch } from "./router-answers"
import type { Answer } from "./router-status"

/**
 * Human labels for the models behind a chat message. Shared by the chat UI,
 * the share viewer and the Markdown transcript, so all three name models the
 * same way.
 */

/** "kimi-k3" → "Kimi K3" when the id is all we have. */
export function modelLabel(id: string): string {
  const bare = id.replace(/[:-]free$/i, "")
  const name = displayName({ id: bare })
  if (name !== bare.split("/").pop()) return name
  return name
    .split("-")
    .map((t) => (/^(gpt|glm|oss|llm)$/i.test(t) ? t.toUpperCase() : /^\d+[bk]$/i.test(t) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1)))
    .join(" ")
}

/** "Auto" / "Fast" for router aliases, else the model's label. */
export function aliasLabel(modelID: string): string {
  return modelID === "fast" ? "Fast" : modelID === "auto" ? "Auto" : modelLabel(modelID)
}

export function backendLabel(a: Pick<Answer, "modelId" | "providerId">): string {
  return `${modelLabel(a.modelId)} (${providerName(a.providerId)})`
}

function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/** A visible line when the router changed models or retried for this message, so switches are never silent. */
export function switchNote(mine: Answer[], all: Answer[], created: number): string | null {
  const s = routerSwitch(mine, all, created)
  if (!s) return null
  if (s.kind === "stopped") return `Switched to ${backendLabel(s.to)} — ${listNames([...new Set(s.from.map((a) => modelLabel(a.modelId)))])} stopped mid-answer`
  if (s.kind === "escalated") return `Escalated from ${modelLabel(s.from.modelId)} to ${backendLabel(s.to)} for a harder step`
  if (s.kind === "unavailable") return `Switched to ${backendLabel(s.to)} — ${modelLabel(s.from.modelId)} was busy`
  return `${backendLabel(s.to)} answered after ${s.to.attempts} tries — the first pick was busy`
}
