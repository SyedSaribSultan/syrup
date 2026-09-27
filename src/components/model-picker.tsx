"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { useEngine } from "@/lib/engine-store"
import { useDismiss } from "@/lib/use-dismiss"
import { useKeyTiers, type KeyTiers } from "@/lib/use-key-tiers"
import { useRouterStatus } from "@/lib/use-router-status"
import { useSessionAnswers } from "@/lib/use-session-answers"
import { Brew } from "./brew"
import { MAX_FAVORITES, modelKey, recordRecent, toggleFavorite, useModelPrefs } from "@/lib/model-prefs"
import { costTier, displayName, providerName } from "@/lib/model-registry"
import {
  ALIAS_COPY,
  AliasIcon,
  Chevron,
  Detail,
  Glyphs,
  Star,
  aliasNow,
  buildItems,
  computeMeta,
  keyAccess,
  rowStatus,
  type AliasNow,
  type Item,
} from "./model-picker-parts"

const optionId = (key: string) => `mp-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`

/** The open chat: /s/<id> locally, /w/<workspace>/s/<id> in the cloud. Undefined on a new chat. */
function useSessionId(): string | undefined {
  const params = useParams<{ id?: string; sid?: string }>()
  const pathname = usePathname()
  return params?.sid ?? (pathname?.startsWith("/s/") ? params?.id : undefined)
}

export function ModelPicker() {
  const { models, model } = useEngine()
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState({ up: true, max: 560 })
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // Focus inside the picker returns to the trigger; otherwise it falls to <body> when the panel unmounts.
  const close = useCallback(() => {
    if (ref.current?.contains(document.activeElement)) trigger.current?.focus()
    setOpen(false)
  }, [])

  // Opens upward unless the composer sits too high (the empty-chat home), then uses whichever side has room.
  function toggle() {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect()
      const below = window.innerHeight - r.bottom
      const up = r.top >= 360 || r.top >= below
      setPlace({ up, max: Math.max(240, Math.min(560, window.innerHeight * 0.7, (up ? r.top : below) - 16)) })
    }
    setOpen((v) => !v)
  }
  useDismiss(ref, open, close)

  const sessionId = useSessionId()
  const isAlias = model?.providerID === "syrup"
  const status = useRouterStatus(isAlias && !sessionId, 60_000)
  const answers = useSessionAnswers(isAlias ? sessionId : undefined)
  const current = models.find((m) => m.providerID === model?.providerID && m.id === model?.modelID)
  const tiers = useKeyTiers(!!current && !current.free && !isAlias, 60_000)
  const now = isAlias && model ? aliasNow(model.modelID, { sessionId, answers, status, models }) : null
  const title = isAlias ? (ALIAS_COPY[model!.modelID]?.title ?? model!.modelID) : null
  const badge = !current || isAlias ? null : current.free ? "free" : keyAccess(current, tiers) === "free-tier" ? "free tier" : null

  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={toggle}
        title={now ? (now.inChat ? `${title} is using ${now.name} (${now.provider}) in this chat` : `${title} last used ${now.name} (${now.provider}); a new chat may get another model`) : undefined}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition hover:bg-surface-2 hover:text-ink ${open ? "bg-surface-2 text-ink" : "text-ink-2"}`}
      >
        <span className="max-w-[260px] truncate">
          {title ?? (current ? displayName(current) : model ? model.modelID : "Pick a model")}
          {now && (
            <span className="text-muted">
              {" "}
              · {now.inChat ? "" : "last used "}
              {now.name}
            </span>
          )}
        </span>
        {badge && <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">{badge}</span>}
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {open && <Panel onClose={close} up={place.up} maxHeight={place.max} sessionId={sessionId} />}
    </div>
  )
}

/** Item key plus the model it shows, so the highlight follows a model that moves section (e.g. when starred). */
type Cursor = { key: string | null; model: string | null }

function Panel({ onClose, up, maxHeight, sessionId }: { onClose(): void; up: boolean; maxHeight: number; sessionId?: string }) {
  const { models, model, setModel, hasKeys, directory } = useEngine()
  const status = useRouterStatus(true)
  const answers = useSessionAnswers(sessionId)
  const tiers = useKeyTiers(true, 10_000)
  const { favorites, recents } = useModelPrefs()
  const [query, setQuery] = useState("")
  const [allOpen, setAllOpen] = useState(false)
  const [olderOpen, setOlderOpen] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const current = model ? modelKey(model.providerID, model.modelID) : null
  const [cursor, setCursor] = useState<Cursor>({ key: null, model: current })
  const list = useRef<HTMLDivElement>(null)

  const meta = useMemo(() => computeMeta(models), [models])
  const items = useMemo(
    () => buildItems({ models, meta, query, favorites, recents, current, allOpen, olderOpen, hasKeys, tiers }),
    [models, meta, query, favorites, recents, current, allOpen, olderOpen, hasKeys, tiers],
  )
  const nav = items.filter((i) => i.kind !== "header")
  const active = nav.find((i) => i.key === cursor.key) ?? (cursor.model ? nav.find((i) => keyOfItem(i) === cursor.model) : undefined) ?? nav[0]
  const point = (i: Item) => setCursor({ key: i.key, model: keyOfItem(i) })
  const nowFor = (id: string) => aliasNow(id, { sessionId, answers, status, models })

  useLayoutEffect(() => {
    if (active) document.getElementById(optionId(active.key))?.scrollIntoView({ block: "nearest" })
    // Only on open: later moves scroll from the key handler, so hovering never jumps the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 3_000)
    return () => clearTimeout(t)
  }, [notice])

  function star(key: string) {
    if (!toggleFavorite(key, (k) => meta.info.has(k))) setNotice(`You can star up to ${MAX_FAVORITES} models. Unstar one to add another.`)
  }

  function activate(item: Item) {
    if (item.kind === "toggle") {
      if (item.key === "t:all") setAllOpen((v) => !v)
      else {
        const pid = item.key.slice("t:older:".length)
        setOlderOpen((s) => {
          const next = new Set(s)
          if (!next.delete(pid)) next.add(pid)
          return next
        })
      }
      setCursor({ key: item.key, model: null })
      return
    }
    if (item.kind === "header") return
    setModel({ providerID: item.m.providerID, modelID: item.m.id })
    if (item.m.providerID !== "syrup") recordRecent(modelKey(item.m.providerID, item.m.id))
    onClose()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!nav.length) return
      const at = active ? nav.indexOf(active) : -1
      const next = nav[(at + (e.key === "ArrowDown" ? 1 : -1) + nav.length) % nav.length]
      point(next)
      document.getElementById(optionId(next.key))?.scrollIntoView({ block: "nearest" })
    } else if (e.key === "Enter" && active) {
      e.preventDefault()
      activate(active)
    }
  }

  return (
    <div
      className={`pop absolute left-0 z-30 flex w-[420px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-card ${up ? "" : "top-full mt-2"}`}
      // Fixed height, positioned by its top edge: switching rows or filtering never moves the rows under the cursor.
      style={up ? { height: maxHeight, top: -(maxHeight + 8) } : { height: maxHeight }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3.5">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="shrink-0 text-muted">
          <circle cx="6" cy="6" r="4.2" />
          <path d="m9.2 9.2 3 3" />
        </svg>
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor({ key: null, model: null })
            list.current?.scrollTo({ top: 0 })
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded
          aria-controls="mp-list"
          aria-activedescendant={active ? optionId(active.key) : undefined}
          aria-label="Search models"
          placeholder="Search models, providers, “free”, “vision”…"
          className="min-w-0 flex-1 bg-transparent py-2.5 text-[13px] text-ink outline-none placeholder:text-muted"
        />
      </div>

      <div ref={list} id="mp-list" role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {models.length === 0 && !directory ? (
          <div className="px-3.5 py-3">
            <Brew mood="load" />
          </div>
        ) : models.length === 0 ? (
          <div className="px-3.5 py-3 text-[13px] text-muted">
            No models yet.{" "}
            <Link href="/settings/providers" onClick={onClose} className="text-accent hover:underline">
              Add a provider key
            </Link>
          </div>
        ) : items.length === 0 ? (
          <div className="px-3.5 py-3 text-[13px] text-muted">No models match “{query.trim()}”.</div>
        ) : (
          items.map((item) => (
            <Row
              key={item.key}
              item={item}
              active={item === active}
              current={current}
              favorites={favorites}
              status={status}
              tiers={tiers}
              nowFor={nowFor}
              onPick={activate}
              onHover={point}
              onStar={star}
              onClose={onClose}
            />
          ))
        )}
      </div>

      <div className="h-[84px] shrink-0 space-y-0.5 overflow-hidden border-t border-line bg-surface-2/40 px-3.5 py-2">
        {notice ? (
          <div role="status" className="text-[11px] text-warn">
            {notice}
          </div>
        ) : (
          <Detail item={active} status={status} tiers={tiers} nowFor={nowFor} />
        )}
      </div>
    </div>
  )
}

function keyOfItem(i: Item): string | null {
  return i.kind === "alias" || i.kind === "model" ? modelKey(i.m.providerID, i.m.id) : null
}

type RowProps = {
  item: Item
  active: boolean
  current: string | null
  favorites: string[]
  status: ReturnType<typeof useRouterStatus>
  tiers: KeyTiers | null
  nowFor(aliasId: string): AliasNow | null
  onPick(i: Item): void
  onHover(i: Item): void
  onStar(key: string): void
  onClose(): void
}

function Row({ item, active, current, favorites, status, tiers, nowFor, onPick, onHover, onStar, onClose }: RowProps) {
  if (item.kind === "header") return <div className="px-3.5 pt-2.5 pb-1 text-[11px] font-medium text-muted">{item.label}</div>

  const common = {
    id: optionId(item.key),
    role: "option" as const,
    onMouseMove: () => !active && onHover(item),
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
    onClick: () => onPick(item),
  }
  const bg = active ? "bg-surface-2" : ""

  if (item.kind === "toggle") {
    return (
      <div {...common} aria-selected={false} aria-expanded={item.open} className={`mx-1.5 mt-1 flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-ink-2 ${item.nested ? "ml-4" : ""} ${bg}`}>
        <Chevron open={item.open} />
        {item.label}
      </div>
    )
  }

  const key = modelKey(item.m.providerID, item.m.id)
  const selected = key === current
  const check = (
    <span className="w-3.5 shrink-0 text-accent">
      {selected && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m2.5 6.2 2.3 2.3 4.7-5" />
        </svg>
      )}
    </span>
  )

  if (item.kind === "alias") {
    const copy = ALIAS_COPY[item.m.id]
    const now = nowFor(item.m.id)
    return (
      <div {...common} aria-selected={selected} className={`mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 ${bg}`}>
        <AliasIcon id={item.m.id} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-ink">{copy?.title ?? displayName(item.m)}</span>
          <span className="block text-[11px] leading-snug text-muted">{copy?.subtitle}</span>
        </span>
        {now && (
          <span className="max-w-[150px] shrink-0 truncate text-[11px] text-muted" title={`${now.name} · ${now.provider}`}>
            {now.inChat ? "now" : "last used"}: {now.name}
          </span>
        )}
        {check}
      </div>
    )
  }

  const m = item.m
  const st = rowStatus(m, status, tiers)
  const fav = favorites.includes(key)
  const freeTier = keyAccess(m, tiers) === "free-tier"
  const tier = freeTier ? 0 : costTier(m)
  const hint = item.tag ?? (st?.tone === "muted" ? st.text : null)
  const chip = hint ? undefined : item.chip
  const freeLabel = m.free ? "Free" : freeTier ? "Free tier" : null
  return (
    <div {...common} aria-selected={selected} className={`group mx-1.5 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ${bg}`}>
      <span className={`flex min-w-0 flex-1 items-center gap-1.5 ${st?.fixKey || item.tag ? "opacity-60" : ""}`}>
        <span className="truncate text-[13px] text-ink">{displayName(m)}</span>
        {item.showProvider && <span className="min-w-[3ch] shrink-[4] truncate text-[11px] text-muted">{providerName(m.providerID)}</span>}
        {freeLabel && chip !== "Free" && <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">{freeLabel}</span>}
        {chip && <span className={`shrink-0 rounded px-1 text-[10px] font-medium ${chip === "Free" ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-2 ring-1 ring-line"}`}>{chip}</span>}
        {hint && <span className="min-w-0 shrink truncate text-[11px] text-muted">{hint}</span>}
      </span>
      {st && st.tone !== "muted" ? (
        <span className={`flex shrink-0 items-center gap-1 text-[11px] ${st.tone === "err" ? "text-err" : "text-warn"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${st.tone === "err" ? "bg-err" : "bg-warn"}`} />
          {st.text}
          {st.fixKey && (
            <Link
              href="/settings/providers"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              className="ml-1 text-accent hover:underline"
            >
              Fix key
            </Link>
          )}
        </span>
      ) : (
        <Glyphs m={m} />
      )}
      <span className="w-6 shrink-0 text-right text-[11px] tracking-tight text-muted" title={tier ? "Relative price" : undefined}>
        {"$".repeat(tier)}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={fav ? "Remove from favorites" : "Add to favorites"}
        title={fav ? "Remove from favorites" : `Add to favorites (up to ${MAX_FAVORITES})`}
        onClick={(e) => {
          e.stopPropagation()
          onStar(key)
        }}
        className={`shrink-0 rounded p-0.5 transition hover:text-accent ${fav ? "text-accent" : "text-muted"} ${fav || active ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      >
        <Star filled={fav} />
      </button>
      {check}
    </div>
  )
}
