"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useEngine } from "@/lib/engine-store"

type Tier = "free" | "paid"
type KeyInfo = { id: string; label: string; tier: Tier; hint: string; active: boolean; createdAt: number }
type Curated = { rank: number; keyUrl: string; note: string; freeTier: boolean; trainsOnData?: boolean }
type ProviderInfo = {
  id: string
  name: string
  connected: boolean
  models: number
  freeModels: number
  env: string[]
  keys: KeyInfo[]
  curated?: Curated
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const { refreshProviders } = useEngine()

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
    await refreshProviders()
  }, [load, refreshProviders])

  const connected = useMemo(() => (providers ?? []).filter((p) => p.connected && p.id !== "opencode"), [providers])
  const recommended = useMemo(
    () =>
      (providers ?? [])
        .filter((p) => p.curated && !p.connected)
        .sort((a, b) => a.curated!.rank - b.curated!.rank),
    [providers],
  )
  const others = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (providers ?? [])
      .filter((p) => !p.connected && !p.curated && p.id !== "opencode")
      .filter((p) => !s || `${p.id} ${p.name}`.toLowerCase().includes(s))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [providers, q])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-6 py-8">
        <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink">Providers</h1>
        <p className="mt-1 max-w-[640px] text-sm text-muted">
          Add API keys from any provider. Keys are encrypted and stay on this machine. You can keep several keys per provider; the active one is what the agent uses.
        </p>

        {error && <div className="mt-4 rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-[13px] text-err">{error}</div>}
        {!providers && !error && <div className="mt-6 text-sm text-muted">Loading catalog…</div>}

        {connected.length > 0 && (
          <Section title="Connected" hint={`${connected.length} provider${connected.length === 1 ? "" : "s"}`}>
            {connected.map((p) => (
              <ProviderCard key={p.id} p={p} onChange={changed} open />
            ))}
          </Section>
        )}

        {recommended.length > 0 && (
          <Section title="Recommended" hint="Free tiers first">
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
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                className="w-44 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs outline-none placeholder:text-muted focus:border-line-2"
              />
            }
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {others.slice(0, q ? 200 : 40).map((p) => (
                <ProviderCard key={p.id} p={p} onChange={changed} compact />
              ))}
            </div>
            {!q && others.length > 40 && <div className="mt-2 text-xs text-muted">Search to see the rest.</div>}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, hint, right, children }: { title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink">
          {title} {hint && <span className="ml-1 font-normal text-muted">· {hint}</span>}
        </h2>
        {right}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function ProviderCard({ p, onChange, open: initiallyOpen, compact }: { p: ProviderInfo; onChange(): Promise<void>; open?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(!!initiallyOpen)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [tier, setTier] = useState<Tier>(p.curated?.freeTier === false ? "paid" : "free")

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

  return (
    <div className={`rounded-xl border bg-surface shadow-card transition ${p.connected ? "border-ok/40" : "border-line"}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={`h-2 w-2 shrink-0 rounded-full ${p.connected ? "bg-ok" : "bg-line-2"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{p.name}</span>
            {c?.freeTier && <span className="rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">free tier</span>}
            {p.connected && <span className="text-[11px] text-muted">{p.models} models</span>}
          </div>
          {!compact && c && <div className="mt-0.5 text-[13px] text-ink-2">{c.note}</div>}
          {compact && <div className="text-[11px] text-muted">{p.id}</div>}
        </div>
        <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 opacity-60 transition ${open ? "rotate-180" : ""}`}>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-line px-4 py-3">
          {p.keys.length > 0 && (
            <ul className="mb-3 space-y-1.5">
              {p.keys.map((k) => (
                <li key={k.id} className="flex items-center gap-2 text-[13px]">
                  <span className={`h-1.5 w-1.5 rounded-full ${k.active ? "bg-ok" : "bg-line-2"}`} />
                  <span className="text-ink">{k.label}</span>
                  <span className="font-mono text-xs text-muted">{k.hint}</span>
                  <span className={`rounded px-1 text-[10px] font-medium ${k.tier === "free" ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-2"}`}>{k.tier}</span>
                  <span className="flex-1" />
                  {!k.active && (
                    <Small onClick={() => call(k.id, () => fetch(`/api/providers/${p.id}/keys/${k.id}`, { method: "PATCH" }))} disabled={!!busy}>
                      Use this key
                    </Small>
                  )}
                  {k.active && <span className="text-[11px] text-muted">active</span>}
                  <Small onClick={() => call(k.id, () => fetch(`/api/providers/${p.id}/keys/${k.id}`, { method: "DELETE" }))} disabled={!!busy} tone="err">
                    Remove
                  </Small>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              placeholder={p.env[0] ? `${p.env[0]} value` : "API key"}
              className="min-w-[220px] flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted focus:border-line-2"
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional)"
              className="w-36 rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] outline-none placeholder:text-muted focus:border-line-2"
            />
            <div className="flex rounded-lg border border-line p-0.5 text-xs">
              {(["free", "paid"] as Tier[]).map((t) => (
                <button key={t} type="button" onClick={() => setTier(t)} className={`rounded-md px-2 py-1 transition ${tier === t ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                  {t}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void add()}
              disabled={!key.trim() || !!busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink transition disabled:opacity-40"
            >
              {busy === "add" ? "Saving…" : "Add key"}
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
            {c && (
              <a href={c.keyUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                Get a key ↗
              </a>
            )}
            {c?.trainsOnData && <span>Free tier may use your prompts for training.</span>}
            {p.env.length > 0 && <span>Also reads {p.env.join(", ")} from the environment.</span>}
          </div>
          {err && <div className="mt-2 text-[12px] text-err">{err}</div>}
        </div>
      )}
    </div>
  )
}

function Small({ children, onClick, disabled, tone }: { children: React.ReactNode; onClick(): void; disabled?: boolean; tone?: "err" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-1.5 py-0.5 text-[11px] transition disabled:opacity-40 ${tone === "err" ? "text-muted hover:text-err" : "text-ink-2 hover:text-ink"}`}
    >
      {children}
    </button>
  )
}
