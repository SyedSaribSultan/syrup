"use client"

import { Icon } from "./ui/s"
import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { useEngine } from "@/lib/engine-store"
import { useDismiss } from "@/lib/use-dismiss"
import { useKeyTiers, type KeyTiers } from "@/lib/use-key-tiers"
import { useOverlay } from "@/lib/use-presence"
import { useCoarsePointer } from "@/lib/use-window-class"
import { useRouterStatus } from "@/lib/use-router-status"
import { useSessionAnswers } from "@/lib/use-session-answers"
import { Brew } from "./brew"
import { Popover } from "./ui/sheet"
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

/**
 * `variant="bar"`: the phone/tablet top bar's title ("Auto ▾"), where the model lives below the expanded
 * breakpoint (docs/RESPONSIVE.md §5.1). Below that breakpoint the list opens as a full-height sheet.
 */
export function ModelPicker({ variant = "composer" }: { variant?: "composer" | "bar" }) {
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
    // In the top bar the picker must be able to shrink (min-w-0), or a long model name pushes past the icons.
    <div ref={ref} className={variant === "bar" ? "relative min-w-0 max-w-full" : "relative"}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={toggle}
        title={now ? (now.inChat ? `${title} is using ${now.name} (${now.provider}) in this chat` : `${title} last used ${now.name} (${now.provider}); a new chat may get another model`) : undefined}
        className={
          variant === "bar"
            ? `flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-base transition hover:bg-surface-2 pointer-coarse:py-2.5 ${open ? "bg-surface-2" : ""}`
            : `flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition hover:bg-surface-2 hover:text-ink ${open ? "bg-surface-2 text-ink" : "text-ink-2"}`
        }
      >
        {variant === "bar" ? (
          <span className="min-w-0 truncate">
            <span className="font-medium text-ink">{title ?? (current ? displayName(current) : model ? model.modelID : "Pick a model")}</span>
            {now && <span className="text-muted"> {now.name}</span>}
          </span>
        ) : (
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
        )}
        {badge && <span className="s-badge shrink-0">{badge}</span>}
        <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0 text-muted">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {/* A full-height sheet below the expanded breakpoint. On desktop: fixed height, positioned by its top edge, so
          switching rows or filtering never moves the rows under the cursor. It opens up or down (`place`), and travels
          in from that side (docs/MOTION.md §4.5). */}
      <Popover
        open={open}
        onClose={close}
        size="full"
        label="Choose a model"
        side={place.up ? "up" : "down"}
        className={`s-raised s-raised--md absolute left-0 z-dropdown flex w-[420px] max-w-[calc(100vw-24px)] flex-col overflow-hidden ${place.up ? "" : "top-full mt-2"}`}
        style={place.up ? { height: place.max, top: -(place.max + 8) } : { height: place.max }}
      >
        <Panel onClose={close} sessionId={sessionId} />
      </Popover>
    </div>
  )
}

/** Item key plus the model it shows, so the highlight follows a model that moves section (e.g. when starred). */
type Cursor = { key: string | null; model: string | null }

function Panel({ onClose, sessionId }: { onClose(): void; sessionId?: string }) {
  const coarse = useCoarsePointer()
  // "Add a provider key" and "Fix key" navigate: the picker closes without its exit (docs/MOTION.md §4.3).
  const overlay = useOverlay()
  const leave = () => {
    overlay?.skipExit()
    onClose()
  }
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4">
        <Icon name="search" size={16} className="text-muted" />
        <input
          // A touch keyboard would cover half the list before anyone asked to search.
          autoFocus={!coarse}
          type="search"
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
          className="min-w-0 flex-1 bg-transparent py-3 text-sm text-ink outline-none placeholder:text-muted"
        />
      </div>

      <div ref={list} id="mp-list" role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto p-1">
        {models.length === 0 && !directory ? (
          <div className="px-3.5 py-3">
            <Brew mood="load" />
          </div>
        ) : models.length === 0 ? (
          <p className="s-empty-line px-3 py-3">
            No models yet.{" "}
            <Link href="/settings/providers" onClick={leave} className="s-link">
              Add a provider key
            </Link>
          </p>
        ) : items.length === 0 ? (
          <p className="s-empty-line px-3 py-3">No models match “{query.trim()}”. Try “free” or a provider name.</p>
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
              onLeave={leave}
            />
          ))
        )}
      </div>

      <div className="h-[84px] shrink-0 space-y-0.5 overflow-hidden border-t border-line px-4 py-2">
        {notice ? (
          <div role="status" className="text-2xs text-warn">
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
  /** Closes the picker for a link that navigates. */
  onLeave(): void
}

function Row({ item, active, current, favorites, status, tiers, nowFor, onPick, onHover, onStar, onLeave }: RowProps) {
  if (item.kind === "header") return <div className="s-menu__label">{item.label}</div>

  const common = {
    id: optionId(item.key),
    role: "option" as const,
    "data-active": active ? "" : undefined,
    onMouseMove: () => !active && onHover(item),
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
    onClick: () => onPick(item),
  }
  // Rows are the Sarib menu item (s-menu__item, 03 B8): r12 inside the r16 raised panel, the active one fill-secondary.
  const row = "s-menu__item"

  if (item.kind === "toggle") {
    return (
      <div {...common} aria-selected={false} aria-expanded={item.open} className={`${row} mt-1 gap-2 ${item.nested ? "ml-3" : ""}`}>
        <Chevron open={item.open} />
        {item.label}
      </div>
    )
  }

  const key = modelKey(item.m.providerID, item.m.id)
  const selected = key === current
  const check = (
    // Selected = a trailing check in ink, no fill, no weight change (03 B2 listbox).
    <span className="flex w-4 shrink-0 text-ink">{selected && <Icon name="check" size={16} />}</span>
  )

  if (item.kind === "alias") {
    const copy = ALIAS_COPY[item.m.id]
    const now = nowFor(item.m.id)
    return (
      <div {...common} aria-selected={selected} className={`${row} gap-3`}>
        <AliasIcon id={item.m.id} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink">{copy?.title ?? displayName(item.m)}</span>
          <span className="block text-xs text-muted">{copy?.subtitle}</span>
        </span>
        {now && (
          <span className="max-w-[150px] shrink-0 truncate text-2xs text-muted" title={`${now.name} · ${now.provider}`}>
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
    <div {...common} aria-selected={selected} className={`group ${row} gap-2`}>
      {/* A model that can't run now reads in the muted text step, not at reduced opacity (states are colour-only). */}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className={`truncate text-sm ${st?.fixKey || item.tag ? "text-ink-2" : "text-ink"}`}>{displayName(m)}</span>
        {item.showProvider && <span className="min-w-[3ch] shrink-[4] truncate text-2xs text-muted">{providerName(m.providerID)}</span>}
        {/* Badges are neutral: red never repeats down a list (rule 11). */}
        {freeLabel && chip !== "Free" && <span className="s-badge shrink-0">{freeLabel}</span>}
        {chip && <span className="s-badge shrink-0">{chip}</span>}
        {hint && <span className="min-w-0 shrink truncate text-2xs text-muted">{hint}</span>}
      </span>
      {st && st.tone !== "muted" ? (
        <span className={`flex shrink-0 items-center gap-1 text-2xs ${st.tone === "err" ? "text-err" : "text-warn"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${st.tone === "err" ? "bg-err" : "bg-warn"}`} />
          {st.text}
          {st.fixKey && (
            <Link
              href="/settings/providers"
              onClick={(e) => {
                e.stopPropagation()
                onLeave()
              }}
              className="s-link ml-1"
            >
              Fix key
            </Link>
          )}
        </span>
      ) : (
        <Glyphs m={m} />
      )}
      <span className="w-6 shrink-0 text-right text-2xs tracking-tight text-muted" title={tier ? "Relative price" : undefined}>
        {"$".repeat(tier)}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={fav ? "Remove from favorites" : "Add to favorites"}
        data-s-tip={fav ? "Remove from favorites" : `Add to favorites (up to ${MAX_FAVORITES})`}
        onClick={(e) => {
          e.stopPropagation()
          onStar(key)
        }}
        className={`shrink-0 rounded-md p-0.5 transition hover:text-ink pointer-coarse:p-2 ${fav ? "text-ink" : "text-muted"} ${fav || active ? "opacity-100" : "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"}`}
      >
        <Star filled={fav} />
      </button>
      {check}
    </div>
  )
}
