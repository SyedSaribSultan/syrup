"use client"

import type { Model } from "@/lib/oc"
import type { Answer, RouterStatus } from "@/lib/router-status"
import type { KeyTiers } from "@/lib/use-key-tiers"
import { currentAnswer } from "@/lib/use-session-answers"
import { fmtTokens } from "@/lib/format"
import { MAX_FAVORITES, modelKey } from "@/lib/model-prefs"
import {
  displayName,
  freeKeyServes,
  freeLimits,
  kindOf,
  modelInfo,
  providerName,
  reasoningCapable,
  toolCapable,
  visibility,
  visionCapable,
  type ModelInfo,
  type ModelLike,
  type Visibility,
} from "@/lib/model-registry"

export type PickerModel = Model & { free: boolean } & ModelLike
export type Chip = "Top pick" | "Fast" | "Free" | "1M context"
export type Item =
  | { kind: "alias"; key: string; m: PickerModel }
  | { kind: "model"; key: string; m: PickerModel; showProvider: boolean; chip?: Chip; tag?: string }
  | { kind: "toggle"; key: string; label: string; open: boolean; nested?: boolean }
  | { kind: "header"; key: string; label: string }
export type RowStatus = { tone: "warn" | "err" | "muted"; text: string; fixKey?: boolean }
export type Meta = { vis: Map<string, Visibility>; info: Map<string, ModelInfo> }

export const ALIAS_COPY: Record<string, { title: string; subtitle: string; detail: string }> = {
  auto: {
    title: "Auto",
    subtitle: "Best model for each chat from your keys",
    detail: "Sticks to one model per chat and switches only if it fails. OpenCode Zen models are direct picks — Auto can't route them.",
  },
  fast: { title: "Fast", subtitle: "Quickest capable model", detail: "Picks the quickest capable model. Sticks to it per chat, switches only if it fails." },
}

/** Providers the router never routes (Zen's free tier refuses proxied requests), so router state about them is stale. */
const DIRECT_ONLY = new Set(["opencode", "syrup"])

export type Access = "free-tier" | "paid-only" | null

/** What the user's key tier means for a priced model: free on their free-tier key, or out of that key's reach. */
export function keyAccess(m: PickerModel, tiers: KeyTiers | null): Access {
  if (m.free || DIRECT_ONLY.has(m.providerID)) return null
  const tier = tiers?.get(m.providerID)
  if (tier === "paid") return null
  if (tier === "free") return freeKeyServes(m.providerID, m) ? "free-tier" : "paid-only"
  // Tier unknown (env key, or not loaded yet): flag only models no free tier serves.
  return freeLimits(m.providerID, m.id).rpd === 0 ? "paid-only" : null
}

const costsNothing = (m: PickerModel, tiers: KeyTiers | null) => m.free || keyAccess(m, tiers) === "free-tier"

export function computeMeta(models: PickerModel[]): Meta {
  const byProvider = new Map<string, PickerModel[]>()
  for (const m of models) byProvider.set(m.providerID, [...(byProvider.get(m.providerID) ?? []), m])
  const vis = new Map<string, Visibility>()
  const info = new Map<string, ModelInfo>()
  for (const [pid, ms] of byProvider) {
    for (const [id, v] of visibility(ms)) vis.set(modelKey(pid, id), v)
    for (const m of ms) info.set(modelKey(pid, m.id), modelInfo(pid, m))
  }
  return { vis, info }
}

const keyOf = (m: PickerModel) => modelKey(m.providerID, m.id)

function hiddenReason(m: PickerModel): string {
  const kind = kindOf(m)
  if (kind !== "chat") return `${kind} model`
  if (!toolCapable(m)) return "no tool calling"
  if (m.status === "deprecated") return "deprecated"
  return "small context"
}

const fastPick = (i?: ModelInfo) => !!i && i.tps >= 200 && i.ttftMs <= 2000 && i.quality >= 55
const quick = (i?: ModelInfo) => !!i && (i.tps >= 200 || i.ttftMs <= 2000)

type Facts = { info?: ModelInfo; free: boolean }

// A Map, so typed words like "constructor" or "__proto__" never reach Object.prototype.
const KEYWORDS = new Map<string, (m: PickerModel, f: Facts) => boolean>([
  ["free", (_, f) => f.free],
  ["vision", (m) => visionCapable(m)],
  ["image", (m) => visionCapable(m)],
  ["reasoning", (m) => reasoningCapable(m)],
  ["thinking", (m) => reasoningCapable(m)],
  ["fast", (_, f) => quick(f.info)],
])

/** Capability words ("free", "fast") only match models worth listing; aliases and hidden models need a name match. */
function matches(m: PickerModel, words: string[], meta: Meta, tiers: KeyTiers | null): boolean {
  const byName = m.providerID === "syrup" || meta.vis.get(keyOf(m)) === "hidden"
  const alias = m.providerID === "syrup" ? `${ALIAS_COPY[m.id]?.title ?? ""} router` : ""
  const hay = `${displayName(m)} ${m.name} ${m.id} ${m.providerID} ${providerName(m.providerID)} ${alias}`.toLowerCase()
  const facts = { info: meta.info.get(keyOf(m)), free: costsNothing(m, tiers) }
  return words.every((w) => hay.includes(w) || (!byName && !!KEYWORDS.get(w)?.(m, facts)))
}

type BuildInput = {
  models: PickerModel[]
  meta: Meta
  query: string
  favorites: string[]
  recents: string[]
  current: string | null
  allOpen: boolean
  olderOpen: Set<string>
  hasKeys: boolean
  tiers: KeyTiers | null
}

export function buildItems({ models, meta, query, favorites, recents, current, allOpen, olderOpen, hasKeys, tiers }: BuildInput): Item[] {
  const byKey = new Map(models.map((m) => [keyOf(m), m]))
  const quality = (m: PickerModel) => meta.info.get(keyOf(m))?.quality ?? 0
  const rank = { current: 0, older: 1, hidden: 2 }
  const aliases = ["auto", "fast"].map((id) => byKey.get(modelKey("syrup", id))).filter((m): m is PickerModel => !!m)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const out: Item[] = []

  if (words.length) {
    for (const m of aliases) if (matches(m, words, meta, tiers)) out.push({ kind: "alias", key: `q:${keyOf(m)}`, m })
    const hits = models
      .filter((m) => m.providerID !== "syrup" && matches(m, words, meta, tiers))
      .sort((a, b) => rank[meta.vis.get(keyOf(a)) ?? "hidden"] - rank[meta.vis.get(keyOf(b)) ?? "hidden"] || quality(b) - quality(a))
    for (const m of hits.slice(0, 100)) {
      const v = meta.vis.get(keyOf(m))
      out.push({ kind: "model", key: `q:${keyOf(m)}`, m, showProvider: true, tag: v === "older" ? "older" : v === "hidden" ? hiddenReason(m) : undefined })
    }
    return out
  }

  for (const m of aliases) out.push({ kind: "alias", key: keyOf(m), m })
  const shown = new Set<string>()
  const section = (label: string, list: PickerModel[], chips?: Map<string, Chip>) => {
    if (!list.length) return
    out.push({ kind: "header", key: `h:${label}`, label })
    for (const m of list) {
      shown.add(keyOf(m))
      out.push({ kind: "model", key: `${label}:${keyOf(m)}`, m, showProvider: true, chip: chips?.get(keyOf(m)) })
    }
  }

  const pool = (keys: (string | null)[]) => [...new Set(keys)].map((k) => (k ? byKey.get(k) : undefined)).filter((m): m is PickerModel => !!m && m.providerID !== "syrup")
  section("Favorites", pool(favorites).slice(0, MAX_FAVORITES))
  section("Recent", pool([current, ...recents]).filter((m) => !favorites.includes(keyOf(m))).slice(0, 3))

  // Models the user's key tier can't use stay under All models with their "Paid tier only" hint, never here.
  const candidates = models
    .filter((m) => m.providerID !== "syrup" && meta.vis.get(keyOf(m)) === "current" && !shown.has(keyOf(m)) && keyAccess(m, tiers) !== "paid-only")
    .sort((a, b) => quality(b) - quality(a) || Number(costsNothing(b, tiers)) - Number(costsNothing(a, tiers)))
  const picks: PickerModel[] = []
  const perProvider = (pid: string) => picks.filter((p) => p.providerID === pid).length
  for (const m of candidates) if (picks.length < 5 && perProvider(m.providerID) < 2) picks.push(m)
  const fast = candidates.find((m) => fastPick(meta.info.get(keyOf(m))))
  if (fast && !picks.includes(fast)) {
    const sameProvider = perProvider(fast.providerID) >= 2 ? picks.findLastIndex((p) => p.providerID === fast.providerID) : -1
    if (sameProvider >= 0) picks.splice(sameProvider, 1)
    else if (picks.length >= 5) picks.pop()
    picks.push(fast)
  }
  const chips = new Map<string, Chip>()
  for (const [i, m] of picks.entries()) {
    const k = keyOf(m)
    const chip: Chip | null = i === 0 ? "Top pick" : fastPick(meta.info.get(k)) ? "Fast" : m.free ? "Free" : (m.limit?.context ?? 0) >= 1_000_000 ? "1M context" : null
    if (chip) chips.set(k, chip)
  }
  section(hasKeys ? "Recommended for your keys" : "Recommended", picks, chips)

  const listed = models.filter((m) => m.providerID !== "syrup" && meta.vis.get(keyOf(m)) !== "hidden")
  if (!listed.length) return out
  out.push({ kind: "toggle", key: "t:all", label: `All models (${listed.length})`, open: allOpen })
  if (!allOpen) return out
  const groups = new Map<string, PickerModel[]>()
  for (const m of [...listed].sort((a, b) => quality(b) - quality(a))) groups.set(m.providerID, [...(groups.get(m.providerID) ?? []), m])
  const single = groups.size === 1
  for (const [pid, ms] of groups) {
    const cur = ms.filter((m) => meta.vis.get(keyOf(m)) === "current")
    const older = ms.filter((m) => meta.vis.get(keyOf(m)) === "older")
    if (!single) out.push({ kind: "header", key: `h:all:${pid}`, label: `${providerName(pid)} · ${ms.length}` })
    for (const m of cur) out.push({ kind: "model", key: `all:${keyOf(m)}`, m, showProvider: single })
    if (!older.length) continue
    const open = olderOpen.has(pid)
    out.push({ kind: "toggle", key: `t:older:${pid}`, label: `Older & previews (${older.length})`, open, nested: true })
    if (open) for (const m of older) out.push({ kind: "model", key: `all:${keyOf(m)}`, m, showProvider: single })
  }
  return out
}

function wait(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 90 ? `~${s}s` : s < 5400 ? `~${Math.round(s / 60)}m` : `~${Math.round(s / 3600)}h`
}

export function rowStatus(m: PickerModel, status: RouterStatus | null, tiers: KeyTiers | null): RowStatus | null {
  if (status && !DIRECT_ONLY.has(m.providerID)) {
    if (status.authFailures.includes(m.providerID)) return { tone: "err", text: "Key rejected", fixKey: true }
    const b = status.backends.find((x) => x.providerId === m.providerID && x.modelId === m.id)
    if (b?.coolingUntil && b.coolingUntil > status.at) {
      if (b.coolReason === "auth") return { tone: "err", text: "Key rejected", fixKey: true }
      if (b.coolReason === "rpd") return { tone: "warn", text: `Daily limit · resets ${new Date(b.coolingUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` }
      return { tone: "warn", text: `Busy · ${wait(b.coolingUntil - status.at)}` }
    }
  }
  if (keyAccess(m, tiers) === "paid-only") return { tone: "muted", text: "Paid tier only" }
  return null
}

export type AliasNow = { name: string; provider: string; inChat: boolean }
export type NowSource = { sessionId?: string; answers: Answer[] | null; status: RouterStatus | null; models: PickerModel[] }

/**
 * In a chat: the model this chat's alias is stuck to (its newest answer there), since routing is sticky per chat.
 * On a new chat: the alias's most recent pick in any chat, shown as "last used".
 */
export function aliasNow(id: string, { sessionId, answers, status, models }: NowSource): AliasNow | null {
  const pick = sessionId ? currentAnswer(answers ?? null, id) : id === "auto" || id === "fast" ? status?.aliases[id] : null
  if (!pick) return null
  const m = models.find((x) => x.providerID === pick.providerId && x.id === pick.modelId)
  return { name: displayName(m ?? { id: pick.modelId }), provider: providerName(pick.providerId), inChat: !!sessionId }
}

const price = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(2).replace(/\.00$/, "")}`

type DetailProps = { item: Item | undefined; status: RouterStatus | null; tiers: KeyTiers | null; nowFor(aliasId: string): AliasNow | null }

export function Detail({ item, status, tiers, nowFor }: DetailProps) {
  if (!item || item.kind === "toggle" || item.kind === "header") {
    return <div className="text-[11px] text-muted">↑↓ to move · Enter to select · Esc to close · try “free”, “vision”, “fast”</div>
  }
  const m = item.m
  if (item.kind === "alias") {
    const now = nowFor(m.id)
    return (
      <>
        <Line title={ALIAS_COPY[m.id]?.title ?? displayName(m)} id={`syrup/${m.id}`} />
        <div className="text-[11px] text-ink-2">{ALIAS_COPY[m.id]?.detail}</div>
        <div className="text-[11px] text-muted">
          {!now ? "Uses any of your provider keys" : now.inChat ? `This chat is on ${now.name} (${now.provider})` : `Last used ${now.name} (${now.provider}) in another chat`}
        </div>
      </>
    )
  }
  const st = rowStatus(m, status, tiers)
  const freeTier = keyAccess(m, tiers) === "free-tier"
  const rpd = freeTier ? freeLimits(m.providerID, m.id).rpd : undefined
  const cost = m.free ? "Free" : freeTier ? `Free tier${rpd ? ` · ~${rpd} requests/day` : ""}` : `${price(m.cost.input)} in · ${price(m.cost.output)} out per 1M`
  const facts = [m.limit?.context ? `${fmtTokens(m.limit.context)} context` : null, cost, m.release_date ? `Released ${new Date(`${m.release_date}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}` : null]
  return (
    <>
      <Line title={displayName(m)} id={`${m.providerID}/${m.id}`} />
      <div className="truncate text-[11px] text-ink-2">{facts.filter(Boolean).join(" · ")}</div>
      <div className="truncate text-[11px] text-muted">
        {m.providerID === "opencode" ? "No key needed · direct pick" : `Uses your ${freeTier ? "free-tier " : ""}${providerName(m.providerID)} key`}
        {item.tag ? ` · ${item.tag}` : ""}
        {st ? <span className={st.tone === "err" ? "text-err" : st.tone === "warn" ? "text-warn" : ""}> · {st.text}</span> : null}
      </div>
    </>
  )
}

function Line({ title, id }: { title: string; id: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-[12px] font-medium text-ink">{title}</span>
      <span className="truncate font-mono text-[10.5px] text-muted">{id}</span>
    </div>
  )
}

const svg = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round" } as const

export function Glyphs({ m }: { m: PickerModel }) {
  return (
    <span className="flex w-7 shrink-0 items-center justify-end gap-1 text-muted">
      {reasoningCapable(m) && (
        <span title="Reasoning: thinks before answering">
          <svg {...svg}>
            <path d="M6 1.5v1M2.8 2.8l.7.7M9.2 2.8l-.7.7M4.3 9.5h3.4M4.8 11h2.4M4 7.6a2.8 2.8 0 1 1 4 0c-.4.4-.6.8-.6 1.4H4.6c0-.6-.2-1-.6-1.4Z" />
          </svg>
        </span>
      )}
      {visionCapable(m) && (
        <span title="Vision: can read images">
          <svg {...svg}>
            <path d="M1 6s1.8-3.5 5-3.5S11 6 11 6 9.2 9.5 6 9.5 1 6 1 6Z" />
            <circle cx="6" cy="6" r="1.5" />
          </svg>
        </span>
      )}
    </span>
  )
}

export function Star({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
      <path d="m6 1.2 1.45 3 3.3.4-2.43 2.27.62 3.26L6 8.53 3.06 10.13l.62-3.26L1.25 4.6l3.3-.4Z" />
    </svg>
  )
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 transition ${open ? "rotate-90" : ""}`}>
      <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function AliasIcon({ id }: { id: string }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">
        {id === "fast" ? <path d="M8 1.5 3 8h4l-1 4.5L11 6H7l1-4.5Z" /> : <path d="M7 1.5v2.2M7 10.3v2.2M1.5 7h2.2M10.3 7h2.2M3.1 3.1l1.5 1.5M9.4 9.4l1.5 1.5M3.1 10.9l1.5-1.5M9.4 4.6l1.5-1.5" />}
      </svg>
    </span>
  )
}
