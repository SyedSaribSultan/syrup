"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button, Icon } from "@/components/ui/s"
import { RowMenu } from "@/components/pages/row-menu"
import { useOptionalEngine } from "@/lib/engine-store"
import { useRouterStatus } from "@/lib/use-router-status"

type Tier = "free" | "paid"
type KeyInfo = { id: string; label: string; tier: Tier; hint: string; active: boolean; createdAt: number }
type Curated = { rank: number; keyUrl: string; note: string; freeTier: boolean; trainsOnData?: boolean }
type ProviderInfo = {
  id: string
  name: string
  connected: boolean
  routable: boolean
  env: string[]
  keys: KeyInfo[]
  curated?: Curated
}

/** Shipped with syrup: never take a key, never show a key form. Mirrors BUILT_IN in src/server/providers.ts. */
const BUILT_IN = new Set(["syrup", "opencode"])

const DIRECT_ONLY = "Direct pick only: Auto and Fast don't use this provider."

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const engine = useOptionalEngine()
  const refreshProviders = engine?.refreshProviders
  const status = useRouterStatus(true)
  const authFailures = useMemo(() => new Set(status?.authFailures ?? []), [status])

  const load = useCallback(async () => {
    const r = await fetch("/api/providers", { cache: "no-store" })
    const j = await r.json()
    if (!r.ok) {
      setError(j.error ?? "Could not load providers")
      return
    }
    setProviders(j.providers)
  }, [])

  // Initial fetch. State is set from the response callback, not the effect body.
  useEffect(() => {
    let alive = true
    fetch("/api/providers", { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, j: await r.json() }))
      .then(({ ok, j }) => {
        if (!alive) return
        if (!ok) setError(j.error ?? "Could not load providers")
        else setProviders(j.providers)
      })
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [])

  // After any key change, reload this page's data and the model picker's catalog.
  const changed = useCallback(async () => {
    await load()
    await refreshProviders?.()
  }, [load, refreshProviders])

  const connected = useMemo(() => (providers ?? []).filter((p) => p.connected && !BUILT_IN.has(p.id)), [providers])
  const recommended = useMemo(
    () =>
      (providers ?? [])
        .filter((p) => p.curated && !p.connected && !BUILT_IN.has(p.id))
        .sort((a, b) => a.curated!.rank - b.curated!.rank),
    [providers],
  )
  const others = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (providers ?? [])
      .filter((p) => !p.connected && !p.curated && !BUILT_IN.has(p.id))
      .filter((p) => !s || `${p.id} ${p.name}`.toLowerCase().includes(s))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [providers, q])
  const routerReady = connected.some((p) => p.routable)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-4 py-8 medium:px-6">
        <h1 className="font-display text-heading text-ink">Providers</h1>
        <p className="mt-2 max-w-[640px] text-base text-ink-2">
          Add API keys from any provider. Keys are encrypted at rest and only ever used for requests you start. You can keep several keys per provider; the active one is what the agent uses.
        </p>

        {error && (
          <div role="alert" className="s-alert s-alert--critical mt-4">
            <Icon name="circle-alert" />
            <div className="s-alert__body">
              <p className="s-alert__desc">{error}. Reload the page to try again.</p>
            </div>
          </div>
        )}

        <Section title="Built in" hint="Ships with syrup">
          <div className="grid gap-3 medium:grid-cols-2">
            <BuiltInCard
              name="syrup router"
              badge="Built in"
              note="Auto and Fast. Picks the best model for each chat from your keys and fails over instantly. Nothing to set up."
              waiting={providers && !routerReady ? "Add a key below to turn it on." : undefined}
            />
            <BuiltInCard
              name="OpenCode Zen"
              badge="Free models"
              note="Free models with no key: Big Pickle, Muse Spark 1.3, MiMo-V2.6-Flash, Space Bunny and more. Pick them directly in the model picker. Auto can't route them, because OpenCode limits its free tier to OpenCode itself. Free for a limited time; some use your prompts for training."
            />
          </div>
        </Section>

        {!providers && !error && <CatalogSkeleton />}

        {connected.length > 0 && (
          <Section title="Connected" hint={`${connected.length} provider${connected.length === 1 ? "" : "s"}`}>
            {connected.map((p) => (
              <ProviderCard key={p.id} p={p} onChange={changed} open authFailed={authFailures.has(p.id)} />
            ))}
          </Section>
        )}

        {recommended.length > 0 && (
          <Section title="Add next" hint="In order of value for a free setup">
            {recommended.map((p) => (
              <ProviderCard key={p.id} p={p} onChange={changed} />
            ))}
          </Section>
        )}

        {providers && (
          <Section
            title="All providers"
            hint={`${others.length} more`}
            right={
              <div className="s-field s-field--sm w-full medium:w-56">
                <Icon name="search" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search providers" className="s-field__input" />
              </div>
            }
          >
            <div className="grid gap-3 medium:grid-cols-2">
              {others.slice(0, q ? 200 : 40).map((p) => (
                <ProviderCard key={p.id} p={p} onChange={changed} compact />
              ))}
            </div>
            {!q && others.length > 40 && <p className="s-empty-line mt-2">Search to see the rest.</p>}
            {q && others.length === 0 && <p className="s-empty-line mt-2">No provider matches. Try another name.</p>}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, hint, right, children }: { title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      {/* On phones the right-hand control (search) drops under the title at full width. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex flex-wrap items-baseline gap-x-2 text-lg text-ink">
          {title} {hint && <span className="s-meta">{hint}</span>}
        </h2>
        {right && <div className="w-full medium:w-auto">{right}</div>}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

/** A built-in provider: a P2 card with a status dot (success when it works, neutral while it waits for a key). */
function BuiltInCard({ name, badge, note, waiting }: { name: string; badge: string; note: string; waiting?: string }) {
  return (
    <div className="s-card s-card--compact">
      <div className="flex items-center gap-2">
        <span className={`s-dot ${waiting ? "" : "s-dot--success"}`} />
        <span className="truncate text-base text-ink">{name}</span>
        <span className="s-badge">{badge}</span>
      </div>
      <p className="text-sm text-ink-2">{note}</p>
      {waiting && <p className="s-help">{waiting}</p>}
    </div>
  )
}

function ProviderCard({
  p,
  onChange,
  open: initiallyOpen,
  compact,
  authFailed,
}: {
  p: ProviderInfo
  onChange(): Promise<void>
  open?: boolean
  compact?: boolean
  authFailed?: boolean
}) {
  const [open, setOpen] = useState(!!initiallyOpen)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  // Mirrors defaultTier in src/server/providers.ts: a free key on a paid-only provider gives the router nothing.
  const [tier, setTier] = useState<Tier>(p.curated?.freeTier ? "free" : "paid")

  async function call(what: string, fn: () => Promise<Response>) {
    setBusy(what)
    setErr(null)
    try {
      const r = await fn()
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error ?? `Request failed (${r.status})`)
      }
      await onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function add() {
    if (!key.trim()) return
    await call("add", () =>
      fetch(`/api/providers/${p.id}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim(), label: label.trim(), tier }),
      }),
    )
    setKey("")
    setLabel("")
  }

  const c = p.curated

  // A P2 card; status lives in the dot (success / critical / neutral), never in a coloured border. p-0: the head is the
  // expand button, so the card's padding moves onto it (a hit-area reason).
  return (
    <div className="s-card s-card--compact gap-0 p-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 rounded-xl px-5 py-4 text-left">
        <span className={`s-dot ${authFailed ? "s-dot--critical" : p.connected ? "s-dot--success" : ""}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base text-ink">{p.name}</span>
            {c?.freeTier && <span className="s-badge">Free tier</span>}
          </div>
          {!compact && c && <p className="mt-1 text-sm text-ink-2">{c.note}</p>}
          {!compact && !p.routable && <p className="s-help mt-1">{DIRECT_ONLY}</p>}
          {compact && <p className="s-meta">{p.id}</p>}
          {authFailed && <p className="s-error-line mt-2">The last request with this key was rejected. Check it or add a new one.</p>}
        </div>
        <Icon name="chevron-down" size={16} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="@container flex flex-col gap-3 border-t border-line px-5 py-4">
          {p.keys.length > 0 && (
            <ul className="flex flex-col gap-1">
              {p.keys.map((k) => {
                const activate = () => call(k.id, () => fetch(`/api/providers/${p.id}/keys/${k.id}`, { method: "PATCH" }))
                const remove = () => call(k.id, () => fetch(`/api/providers/${p.id}/keys/${k.id}`, { method: "DELETE" }))
                return (
                  <li key={k.id} className="flex min-h-9 items-center gap-3 text-sm">
                    <span className={`s-dot ${k.active ? "s-dot--success" : ""}`} />
                    {/* One line when the card is wide; narrow, the hint (and "active") drop to a second line. */}
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="min-w-0 truncate text-ink">{k.label}</span>
                      <span className="s-meta order-last basis-full @[480px]:order-none @[480px]:basis-auto">
                        {k.hint}
                        {k.active && <span className="@[480px]:hidden"> · active</span>}
                      </span>
                      <span className="s-badge">{k.tier === "free" ? "Free" : "Paid"}</span>
                    </div>
                    <div className="hidden items-center gap-2 @[480px]:flex">
                      {!k.active && (
                        <Button variant="ghost" size="sm" onClick={activate} disabled={!!busy}>
                          Use this key
                        </Button>
                      )}
                      {k.active && <span className="s-meta">Active</span>}
                      <Button variant="ghost" size="sm" onClick={remove} disabled={!!busy}>
                        Remove
                      </Button>
                    </div>
                    <RowMenu
                      className="@[480px]:hidden"
                      label={`Actions for ${k.label}`}
                      title={k.label}
                      items={[
                        ...(k.active ? [] : [{ label: "Use this key", onSelect: () => void activate(), disabled: !!busy }]),
                        { label: "Remove", onSelect: () => void remove(), danger: true, disabled: !!busy },
                      ]}
                    />
                  </li>
                )
              })}
            </ul>
          )}

          {/* Narrow: the key gets its own line, then label, tier and Add share the next. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="s-field s-field--sm w-full @[520px]:w-auto @[520px]:min-w-[220px] @[520px]:flex-1">
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void add()}
                placeholder={p.env[0] ? `${p.env[0]} value` : "API key"}
                aria-label={`${p.name} API key`}
                className="s-field__input"
              />
            </div>
            <div className="s-field s-field--sm w-0 min-w-0 flex-1 @[520px]:w-40 @[520px]:flex-none">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" aria-label="Label" className="s-field__input" />
            </div>
            <div role="group" aria-label="Key tier" className="s-seg">
              {(["free", "paid"] as Tier[]).map((t) => (
                <button key={t} type="button" aria-pressed={tier === t} onClick={() => setTier(t)} className="s-seg__item">
                  {t === "free" ? "Free" : "Paid"}
                </button>
              ))}
            </div>
            <Button size="sm" busy={busy === "add"} disabled={!key.trim() || (!!busy && busy !== "add")} onClick={() => void add()}>
              Add key
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {c && (
              <a href={c.keyUrl} target="_blank" rel="noreferrer" className="s-btn s-btn--link-brand s-btn--sm pointer-coarse:min-h-11">
                <span className="s-btn__label">Get a key</span>
                <Icon name="arrow-up-right" />
              </a>
            )}
            {compact && !p.routable && <span className="s-help">{DIRECT_ONLY}</span>}
            {c?.trainsOnData && <span className="s-help">Free tier may use your prompts for training.</span>}
            {p.env.length > 0 && <span className="s-help">Also reads {p.env.join(", ")} from the environment.</span>}
          </div>
          {err && <p className="s-field-error">{err}</p>}
        </div>
      )}
    </div>
  )
}

/** "Add next" at its real size while the catalog loads, so the page does not grow under the cursor. */
function CatalogSkeleton() {
  return (
    <section aria-busy className="skel-in mt-8">
      <div className="mb-3 flex items-center gap-2">
        <span className="s-skeleton s-skeleton--line w-16" />
        <span className="s-skeleton s-skeleton--line w-44" />
      </div>
      <div className="flex flex-col gap-3">
        {["w-24", "w-32", "w-20"].map((w) => (
          <div key={w} className="s-card s-card--compact">
            <span className={`s-skeleton s-skeleton--row ${w}`} />
            <span className="s-skeleton s-skeleton--line w-3/4" />
          </div>
        ))}
      </div>
    </section>
  )
}
